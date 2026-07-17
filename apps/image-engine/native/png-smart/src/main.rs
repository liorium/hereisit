use png::{BitDepth, ColorType, Encoder};
use quantizr::{Image, Options, QuantizeResult};
use std::collections::HashMap;
use std::error::Error;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read};
use std::path::PathBuf;

const MAX_PIXELS: usize = 40_000_000;

struct Arguments {
    input: PathBuf,
    output: PathBuf,
    width: usize,
    height: usize,
    colors: i32,
}

fn parse_positive(value: &str, name: &str) -> Result<usize, Box<dyn Error>> {
    let parsed = value.parse::<usize>()?;
    if parsed == 0 {
        return Err(format!("{name} must be positive").into());
    }
    Ok(parsed)
}

fn parse_arguments() -> Result<Arguments, Box<dyn Error>> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.len() != 10 {
        return Err("expected --input-rgba, --width, --height, --colors, and --output".into());
    }
    let mut values = HashMap::new();
    for pair in raw.chunks_exact(2) {
        if !pair[0].starts_with("--") || values.insert(pair[0].clone(), pair[1].clone()).is_some() {
            return Err("arguments are invalid or duplicated".into());
        }
    }
    let take = |name: &str| {
        values
            .get(name)
            .cloned()
            .ok_or_else(|| format!("{name} is required"))
    };
    let width = parse_positive(&take("--width")?, "width")?;
    let height = parse_positive(&take("--height")?, "height")?;
    let pixels = width.checked_mul(height).ok_or("pixel count overflow")?;
    if pixels > MAX_PIXELS {
        return Err("pixel count exceeds the engine limit".into());
    }
    let colors = take("--colors")?.parse::<i32>()?;
    if !(2..=256).contains(&colors) {
        return Err("colors must be between 2 and 256".into());
    }
    Ok(Arguments {
        input: take("--input-rgba")?.into(),
        output: take("--output")?.into(),
        width,
        height,
        colors,
    })
}

fn run() -> Result<(), Box<dyn Error>> {
    let arguments = parse_arguments()?;
    let expected_bytes = arguments
        .width
        .checked_mul(arguments.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("RGBA byte count overflow")?;
    let metadata = std::fs::symlink_metadata(&arguments.input)?;
    if !metadata.file_type().is_file() || metadata.len() != expected_bytes as u64 {
        return Err("input must be an exact-length regular RGBA file".into());
    }
    let mut rgba = Vec::with_capacity(expected_bytes);
    File::open(&arguments.input)?.read_to_end(&mut rgba)?;
    if rgba.len() != expected_bytes {
        return Err("input length changed while reading".into());
    }

    let image = Image::new(&rgba, arguments.width, arguments.height)?;
    let mut options = Options::default();
    options.set_max_colors(arguments.colors)?;
    let result = QuantizeResult::quantize(&image, &options);
    let mut indexes = vec![0_u8; arguments.width * arguments.height];
    result.remap_image(&image, &mut indexes)?;
    let palette = result.get_palette();
    let colors = &palette.entries[..palette.count as usize];
    let rgb: Vec<u8> = colors.iter().flat_map(|color| [color.r, color.g, color.b]).collect();
    let mut alpha: Vec<u8> = colors.iter().map(|color| color.a).collect();
    while alpha.last() == Some(&255) {
        alpha.pop();
    }

    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&arguments.output)?;
    let mut encoder = Encoder::new(
        BufWriter::new(output),
        arguments.width as u32,
        arguments.height as u32,
    );
    encoder.set_color(ColorType::Indexed);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_palette(rgb);
    if !alpha.is_empty() {
        encoder.set_trns(alpha);
    }
    encoder.write_header()?.write_image_data(&indexes)?;
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("PNG_SMART_FAILED");
        std::process::exit(1);
    }
}
