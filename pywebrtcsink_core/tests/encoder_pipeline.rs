//! Punto 6: tests de emision de paquetes (OpusPipeline) y downmix multicanal.
//!
//! Sin red ni WASAPI: se prueba que el encoder emite exactamente 1 frame cada
//! 20 ms de PCM de entrada, que seq/ts avanzan correctamente y que el downmix
//! respeta ITU-R BS.775.

use pywebrtcsink_core::audio::resampler::LinearResampler;
use pywebrtcsink_core::codec::opus::OpusPipeline;

const FRAME_SAMPLES: usize = 960 * 2; // 20 ms stereo

/// Emite exactamente un frame por cada 20 ms de PCM, con seq/ts monotonos.
#[test]
fn pipeline_emite_1_frame_por_20ms() {
    let mut pipe = OpusPipeline::new(96_000).expect("encoder");
    let mut packet = vec![0u8; 1275 + 8];
    let pcm = vec![0.05f32; 960 * 2]; // 20ms de senal baja

    for i in 0..50u32 {
        let out = pipe.feed_and_encode(&pcm, &mut packet).expect("encode");
        let n = out.unwrap_or_else(|| panic!("tick {i}: falto frame (cadencia rota)"));
        assert!(n > 8, "tick {i}: frame vacio");

        let seq = u32::from_be_bytes(packet[0..4].try_into().unwrap());
        let ts = u32::from_be_bytes(packet[4..8].try_into().unwrap());
        assert_eq!(seq, i, "seq debe avanzar de a 1");
        assert_eq!(ts, i * 960, "ts debe avanzar de a 960");
    }
}

/// Menos de 20 ms de entrada no debe emitir nada (acumula).
#[test]
fn pipeline_acumula_y_no_emite_frames_parciales() {
    let mut pipe = OpusPipeline::new(96_000).unwrap();
    let mut packet = vec![0u8; 1275 + 8];
    let half = vec![0.05f32; FRAME_SAMPLES / 2];

    assert!(pipe.feed_and_encode(&half, &mut packet).unwrap().is_none(), "10ms no cierran frame");
    let out = pipe.feed_and_encode(&half, &mut packet).unwrap();
    assert!(out.is_some(), "a los 20ms acumulados debe cerrar el frame");
}

/// Latencia del pipeline: no debe acumular PCM de mas (input grande → 1 frame
/// por llamada, resto queda colgado para la siguiente).
#[test]
fn pipeline_no_acapara_pcm_de_mas() {
    let mut pipe = OpusPipeline::new(96_000).unwrap();
    let mut packet = vec![0u8; 1275 + 8];
    let burst = vec![0.05f32; FRAME_SAMPLES * 3]; // 60 ms de golpe

    let n1 = pipe.feed_and_encode(&burst, &mut packet).unwrap();
    assert!(n1.is_some());
    let n2 = pipe.feed_and_encode(&burst, &mut packet).unwrap();
    let n3 = pipe.feed_and_encode(&burst, &mut packet).unwrap();
    // 3 llamadas con 60ms cada una: 180ms totales = 9 frames posibles,
    // cada llamada consume al menos el primero. Si cada llamada emite 1 frame,
    // tras 3 llamadas van 3 frames: seq=0,1,2.
    assert!(n2.is_some() && n3.is_some());
    let seq = u32::from_be_bytes(packet[0..4].try_into().unwrap());
    assert_eq!(seq, 2);
}

/// Ruta completa passthrough: ring → pop alineado → resample (48k) → encode.
#[test]
fn camino_completo_sin_resample_mantiene_cadencia() {
    use rtrb::RingBuffer;
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(48000 * 4);
    let mut resampler = LinearResampler::new(48000, 48000, 2);
    let mut pipe = OpusPipeline::new(96_000).unwrap();

    let mut out_packet = vec![0u8; 1275 + 8];
    let mut frames_out = 0usize;

    // Simular 1 segundo de captura a pasos de 10 ms (medios ticks).
    for _ in 0..100 {
        for _ in 0..480 * 2 {
            let _ = producer.push(0.05f32);
        }
        // encoder loop: pop alineado
        let take = (consumer.slots() / 2).min(960) * 2;
        if take > 0 {
            let chunk = consumer.read_chunk(take).unwrap();
            let (a, b) = chunk.as_slices();
            let mut raw = Vec::with_capacity(take);
            raw.extend_from_slice(a);
            raw.extend_from_slice(b);
            chunk.commit_all();

            let mut resampled = Vec::new();
            resampler.process(&raw, &mut resampled);
            assert_eq!(resampled.len(), take, "passthrough 1:1");
            if pipe.feed_and_encode(&resampled, &mut out_packet).unwrap().is_some() {
                frames_out += 1;
            }
        }
    }
    assert_eq!(frames_out, 50, "1s de captura deben producir 50 frames de 20ms");
}

// ---------- Punto 4: downmix ----------

use pywebrtcsink_core::downmix_to_stereo;

#[test]
fn downmix_51_itu_bs775() {
    // 5.1 mask estandar: FL|FR|C|LFE|BL|BR = 0x3F
    let mask = 0x3F;
    let frame = [0.3f32, 0.3, 0.3, 9.0, 0.3, 0.3]; // LFE=9.0 para ver que se ignora
    let mut out = Vec::new();
    downmix_to_stereo(&frame, 6, mask, &mut out);
    let g = 0.70710677f32;
    // 0.3 * (1 + g + g) < 1.0 → no satura, medimos la mezcla real
    let expect = 0.3 + 0.3 * g + 0.3 * g; // FL + C*g + BL*g
    assert!((out[0] - expect).abs() < 0.01, "L={} esperado {}", out[0], expect);
    assert!((out[1] - expect).abs() < 0.01);
}

#[test]
fn downmix_71_suma_surrounds_laterales() {
    // 7.1: FL FR FC LFE BL BR SL SR = 0x63F
    let mask = 0x3F | 0x200 | 0x400;
    let frame = [0.5f32, 0.5, 0.0, 0.0, 0.25, 0.25, 0.25, 0.25];
    let mut out = Vec::new();
    downmix_to_stereo(&frame, 8, mask, &mut out);
    let g = 0.70710677f32;
    let expect = 0.5 + 0.25 * g + 0.25 * g; // FL + BL*g + SL*g
    assert!((out[0] - expect).abs() < 0.01, "L={} esperado {}", out[0], expect);
}

#[test]
fn downmix_sin_mask_cae_a_primeros_2_canales() {
    let frame = [0.9f32, 0.1, 0.5, 0.5, 0.5, 0.5];
    let mut out = Vec::new();
    downmix_to_stereo(&frame, 6, 0, &mut out);
    assert_eq!(out, vec![0.9, 0.1], "fallback = canales 0 y 1 tal cual");
}

#[test]
fn downmix_clampea_saturacion() {
    let mask = 0x3F;
    let frame = [1.0f32; 6];
    let mut out = Vec::new();
    downmix_to_stereo(&frame, 6, mask, &mut out);
    assert!(out[0] <= 1.0 && out[1] <= 1.0, "clamp a [-1, 1]");
}

#[test]
fn stereo_no_por_downmix_largo_sin_cambio() {
    let mut stim = Vec::new();
    for _ in 0..960 {
        stim.push(0.3f32);
        stim.push(-0.2f32);
    }
    // cuidado: no se usa para stereo normal, solo verifica que el camino de 2
    // canales pasa intacto si alguien lo llama por error con mask stereo.
    let mut out = Vec::new();
    downmix_to_stereo(&stim, 2, 0x3, &mut out);
    assert_eq!(out, stim, "mask FL|FR con 2ch = identidad");
}
