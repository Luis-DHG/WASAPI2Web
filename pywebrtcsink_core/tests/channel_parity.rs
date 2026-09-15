//! Primeros tests del repo (punto 2): paridad L/R end-to-end.
//!
//! Cubre el bug de alineacion: si el ring o el resampler dejan pasar un resto
//! no multiplo del numero de canales, la paridad stereo se invierte
//! permanentemente. Los tests generan un patron L=+1.0 / R=-1.0 y verifican
//! que nunca se invierte ni se desplaza, con chunks de longitudes irregulares.

use rtrb::RingBuffer;

const CHANNELS: usize = 2;

/// Patron stereo: L=+1.0, R=-1.0 en cada frame.
fn push_pattern(producer: &mut rtrb::Producer<f32>, frames: usize) {
    for _ in 0..frames {
        let _ = producer.push(1.0);
        let _ = producer.push(-1.0);
    }
}

/// Pop alineado a frame (misma logica que lib.rs).
fn pop_aligned(consumer: &mut rtrb::Consumer<f32>, out: &mut Vec<f32>, max_frames: usize) {
    let take = (consumer.slots() / CHANNELS).min(max_frames) * CHANNELS;
    if take == 0 {
        return;
    }
    let chunk = consumer.read_chunk(take).expect("read_chunk alineado");
    let (first, second) = chunk.as_slices();
    out.extend_from_slice(first);
    out.extend_from_slice(second);
    chunk.commit_all();
}

/// Verifica que todo el buffer mantiene la paridad: frames pares L>0, impares R<0.
fn assert_parity(buf: &[f32], ctx: &str) {
    assert_eq!(buf.len() % CHANNELS, 0, "{ctx}: longitud no alineada a canales");
    for (frame_idx, frame) in buf.chunks_exact(CHANNELS).enumerate() {
        assert!(frame[0] > 0.0, "{ctx}: frame {frame_idx} tiene L={} (esperado >0, paridad invertida)", frame[0]);
        assert!(frame[1] < 0.0, "{ctx}: frame {frame_idx} tiene R={} (esperado <0, paridad invertida)", frame[1]);
    }
}

#[test]
fn ring_pop_nunca_desalinea_con_chunks_irregulares() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(4096);

    // Cargas irregulares: 1 frame, 7 frames, 100, 3...
    let mut collected = Vec::new();
    for frames in [1usize, 7, 100, 3, 960, 2] {
        push_pattern(&mut producer, frames);
        pop_aligned(&mut consumer, &mut collected, 960);
    }
    // Drenar lo que quede
    pop_aligned(&mut consumer, &mut collected, usize::MAX);

    assert_parity(&collected, "stream troceado");
    let total_expected: usize = [1, 7, 100, 3, 960, 2].iter().sum();
    assert_eq!(collected.len() / CHANNELS, total_expected, "se perdieron frames");
}

#[test]
fn ring_conserva_resto_parcial_sin_romper_paridad() {
    let (mut producer, mut consumer) = RingBuffer::<f32>::new(4096);

    // 5 frames; el pop pide max 2 → quedan 3 en el ring, alineados.
    push_pattern(&mut producer, 5);
    let mut first = Vec::new();
    pop_aligned(&mut consumer, &mut first, 2);
    assert_parity(&first, "primer pop");
    assert_eq!(consumer.slots(), 3 * CHANNELS, "el resto debe quedar en el ring");

    let mut rest = Vec::new();
    pop_aligned(&mut consumer, &mut rest, usize::MAX);
    assert_parity(&rest, "segundo pop");
}

#[test]
fn resampler_passthrough_mantiene_paridad_con_chunks_impares() {
    use pywebrtcsink_core::audio::resampler::LinearResampler;

    // Resampler ratio 1.0 (48k→48k), entrada troceada en longitudes variadas.
    let mut rs = LinearResampler::new(48000, 48000, CHANNELS);
    let mut out = Vec::new();
    for frames in [3usize, 17, 1, 480] {
        let mut chunk = Vec::with_capacity(frames * CHANNELS);
        for _ in 0..frames {
            chunk.push(1.0f32);
            chunk.push(-1.0f32);
        }
        rs.process(&chunk, &mut out);
    }
    assert_parity(&out, "resampler passthrough");
}

#[test]
fn resampler_44100_a_48000_mantiene_paridad_interpolando() {
    use pywebrtcsink_core::audio::resampler::LinearResampler;

    let mut rs = LinearResampler::new(44100, 48000, CHANNELS);
    let mut out = Vec::new();
    // Chunks de distinto tamano, todos alineados a frames.
    for frames in [128usize, 333, 64] {
        let mut chunk = Vec::with_capacity(frames * CHANNELS);
        for _ in 0..frames {
            chunk.push(1.0f32);
            chunk.push(-1.0f32);
        }
                rs.process(&chunk, &mut out);
    }
    // El primer sample sale del estado inicial (0.0): comprobar QUE NO SE
    // INVIERTE el signo (>=/<=), no el signo estricto.
    assert_eq!(out.len() % CHANNELS, 0, "salida no alineada a canales");
    for (i, frame) in out.chunks_exact(CHANNELS).enumerate() {
        assert!(frame[0] >= 0.0, "frame {i}: L={} < 0 → paridad invertida", frame[0]);
        assert!(frame[1] <= 0.0, "frame {i}: R={} > 0 → paridad invertida", frame[1]);
    }
}
