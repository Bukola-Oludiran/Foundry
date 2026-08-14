use std::io::{self, Read};

fn decode_base64(input: &str) -> Result<Vec<u8>, ()> {
    let input = input.trim();
    if input.len() % 4 != 0 { return Err(()); }
    let mut output = Vec::new();
    for chunk in input.as_bytes().chunks(4) {
        let mut value = 0_u32;
        let mut padding = 0;
        for byte in chunk {
            let digit = match *byte {
                b'A'..=b'Z' => u32::from(*byte - b'A'),
                b'a'..=b'z' => u32::from(*byte - b'a' + 26),
                b'0'..=b'9' => u32::from(*byte - b'0' + 52),
                b'+' => 62,
                b'/' => 63,
                b'=' => { padding += 1; 0 },
                _ => return Err(()),
            };
            value = (value << 6) | digit;
        }
        output.push((value >> 16) as u8);
        if padding < 2 { output.push((value >> 8) as u8); }
        if padding < 1 { output.push(value as u8); }
    }
    Ok(output)
}

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() { eprintln!("INPUT_READ_FAILED"); std::process::exit(2); }
    let bytes = match decode_base64(&input) { Ok(value) => value, Err(()) => { eprintln!("INVALID_BASE64"); std::process::exit(2); } };
    println!("{:?}", checksum_core::checksum(&bytes));
}
