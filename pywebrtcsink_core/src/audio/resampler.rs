pub struct LinearResampler {
    ratio: f64,
    channels: usize,
    phase: f64,
    last_samples: Vec<f32>,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        Self {
            ratio: in_rate as f64 / out_rate as f64,
            channels,
            phase: 0.0,
            last_samples: vec![0.0f32; channels],
        }
    }

    /// Resample interleaved input to interleaved output.
    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        debug_assert!(
            input.len() % self.channels == 0,
            "resampler recibio {} samples con {} canales: desbordaria la paridad L/R",
            input.len(),
            self.channels
        );
        // Defensa: nunca propagar un resto no alineado (rompe paridad stereo).
        let aligned_len = input.len() - (input.len() % self.channels);
        let input = &input[..aligned_len];

        if self.ratio == 1.0 {
            output.extend_from_slice(input);
            return;
        }

        let input_frames = input.len() / self.channels;
        if input_frames == 0 {
            return;
        }

        let ch = self.channels;
        while self.phase < input_frames as f64 {
            let idx = self.phase.floor() as usize;
            let frac = (self.phase - idx as f64) as f32;

            for c in 0..ch {
                let s0 = if idx == 0 {
                    self.last_samples[c]
                } else {
                    input[(idx - 1) * ch + c]
                };
                let s1 = input[idx * ch + c];
                let out_sample = s0 + frac * (s1 - s0);
                output.push(out_sample);
            }

            self.phase += self.ratio;
        }

        self.phase -= input_frames as f64;
        for c in 0..ch {
            self.last_samples[c] = input[(input_frames - 1) * ch + c];
        }
    }
}
