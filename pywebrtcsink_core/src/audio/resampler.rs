pub struct LinearResampler {
    in_rate: f64,
    out_rate: f64,
    ratio: f64,
    channels: usize,
    phase: f64,
    last_samples: Vec<f32>,
}

impl LinearResampler {
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Self {
        let in_rate_f = in_rate as f64;
        let out_rate_f = out_rate as f64;
        let ratio = in_rate_f / out_rate_f;
        Self {
            in_rate: in_rate_f,
            out_rate: out_rate_f,
            ratio,
            channels,
            phase: 0.0,
            last_samples: vec![0.0f32; channels],
        }
    }

    /// Resample interleaved input to interleaved output.
    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if (self.in_rate - self.out_rate).abs() < 0.1 {
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
