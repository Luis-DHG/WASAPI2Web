use audiopus::coder::{Encoder, GenericCtl};
use audiopus::{Application, Bitrate, Channels, SampleRate};

pub struct OpusPipeline {
    encoder: Encoder,
    sequence: u32,
    timestamp: u32,
    pcm_accumulator: Vec<f32>,
    samples_per_frame: usize, // 960 * 2 = 1920 samples for stereo 20ms @ 48kHz
}

impl OpusPipeline {
    pub fn new(bitrate_bps: i32) -> anyhow::Result<Self> {
        let mut encoder = Encoder::new(
            SampleRate::Hz48000,
            Channels::Stereo,
            Application::Audio,
        ).map_err(|e| anyhow::anyhow!("Failed to create Opus Encoder: {:?}", e))?;

        encoder.set_bitrate(Bitrate::BitsPerSecond(bitrate_bps))
            .map_err(|e| anyhow::anyhow!("Failed to set Opus bitrate: {:?}", e))?;
        encoder.set_inband_fec(true)
            .map_err(|e| anyhow::anyhow!("Failed to set Opus FEC: {:?}", e))?;
        encoder.set_packet_loss_perc(5)
            .map_err(|e| anyhow::anyhow!("Failed to set Opus packet loss percentage: {:?}", e))?;

        Ok(Self {
            encoder,
            sequence: 0,
            timestamp: 0,
            pcm_accumulator: Vec::with_capacity(960 * 2 * 4),
            samples_per_frame: 960 * 2,
        })
    }

    /// Feeds PCM samples and encodes whenever a 20ms frame (960 samples/ch) is full.
    /// Returns the total bytes written into `out_packet` (including the 8-byte header), or None if more samples are needed.
    #[inline]
    pub fn feed_and_encode(&mut self, pcm_chunk: &[f32], out_packet: &mut [u8]) -> anyhow::Result<Option<usize>> {
        self.pcm_accumulator.extend_from_slice(pcm_chunk);

        if self.pcm_accumulator.len() < self.samples_per_frame {
            return Ok(None);
        }

        let frame_pcm: Vec<f32> = self.pcm_accumulator.drain(..self.samples_per_frame).collect();
        let payload_offset = 8;

        let encoded_len = self.encoder.encode_float(&frame_pcm, &mut out_packet[payload_offset..])
            .map_err(|e| anyhow::anyhow!("Opus encoding failed: {:?}", e))?;

        // 8-byte header: Sequence Number (4B BE) + Timestamp (4B BE)
        out_packet[0..4].copy_from_slice(&self.sequence.to_be_bytes());
        out_packet[4..8].copy_from_slice(&self.timestamp.to_be_bytes());

        self.sequence = self.sequence.wrapping_add(1);
        self.timestamp = self.timestamp.wrapping_add(960);

        Ok(Some(payload_offset + encoded_len))
    }

    pub fn reset(&mut self) {
        self.sequence = 0;
        self.timestamp = 0;
        self.pcm_accumulator.clear();
        let _ = self.encoder.reset_state();
    }
}
