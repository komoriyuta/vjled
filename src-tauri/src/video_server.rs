use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;

pub struct VideoFileServer {
    pub port: u16,
}

impl VideoFileServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind video server");
        let port = listener.local_addr().unwrap().port();

        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || {
                    if let Err(e) = handle_request(stream) {
                        let _ = std::io::stderr()
                            .write_all(format!("Video server error: {}\n", e).as_bytes());
                    }
                });
            }
        });

        Self { port }
    }
}

fn handle_request(mut stream: std::net::TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(30)))?;

    let mut buf = vec![0u8; 8192];
    let n = stream.read(&mut buf)?;
    if n == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buf[..n]);

    let request_line = request.lines().next().unwrap_or("");
    let path_encoded = request_line.split_whitespace().nth(1).unwrap_or("/");

    let path_str = percent_decode(path_encoded.trim_start_matches('/'));
    let file_path = std::path::Path::new(&path_str);

    if !file_path.exists() || !file_path.is_file() {
        let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        stream.write_all(resp.as_bytes())?;
        return Ok(());
    }

    let metadata = file_path.metadata()?;
    let file_size = metadata.len();
    let mime = guess_mime(file_path);

    let range_header = extract_header(&request, "Range");
    let range = parse_range(range_header.as_deref(), file_size);

    let mut file = std::fs::File::open(file_path)?;

    match range {
        Some((start, end)) => {
            let content_len = end - start + 1;
            file.seek(SeekFrom::Start(start))?;

            let header = format!(
                "HTTP/1.1 206 Partial Content\r\n\
                 Content-Type: {}\r\n\
                 Content-Length: {}\r\n\
                 Content-Range: bytes {}-{}/{}\r\n\
                 Accept-Ranges: bytes\r\n\
                 Connection: close\r\n\r\n",
                mime, content_len, start, end, file_size
            );
            stream.write_all(header.as_bytes())?;
            copy_range(&mut file, &mut stream, content_len as usize)?;
        }
        None => {
            let header = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: {}\r\n\
                 Content-Length: {}\r\n\
                 Accept-Ranges: bytes\r\n\
                 Connection: close\r\n\r\n",
                mime, file_size
            );
            stream.write_all(header.as_bytes())?;
            copy_range(&mut file, &mut stream, file_size as usize)?;
        }
    }

    Ok(())
}

fn copy_range(
    file: &mut std::fs::File,
    stream: &mut std::net::TcpStream,
    mut remaining: usize,
) -> std::io::Result<()> {
    let mut buf = [0u8; 65536];
    while remaining > 0 {
        let to_read = remaining.min(buf.len());
        let n = file.read(&mut buf[..to_read])?;
        if n == 0 {
            break;
        }
        stream.write_all(&buf[..n])?;
        remaining -= n;
    }
    Ok(())
}

fn extract_header(request: &str, name: &str) -> Option<String> {
    for line in request.lines() {
        if let Some(colon_pos) = line.find(':') {
            let header_name = &line[..colon_pos];
            if header_name.eq_ignore_ascii_case(name) {
                return Some(line[colon_pos + 1..].trim().to_string());
            }
        }
    }
    None
}

fn parse_range(header: Option<&str>, file_size: u64) -> Option<(u64, u64)> {
    let header = header?;
    if !header.starts_with("bytes=") {
        return None;
    }
    let range_spec = &header[6..];
    let parts: Vec<&str> = range_spec.split('-').collect();
    if parts.len() != 2 {
        return None;
    }
    let start: u64 = parts[0].parse().ok()?;
    if start >= file_size {
        return None;
    }
    let end: u64 = if parts[1].is_empty() {
        file_size - 1
    } else {
        parts[1].parse::<u64>().ok()?.min(file_size - 1)
    };
    Some((start, end))
}

fn percent_decode(input: &str) -> String {
    let mut result = Vec::new();
    let mut bytes = input.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next().unwrap_or(b'0');
            let lo = bytes.next().unwrap_or(b'0');
            let val = |c: u8| -> u8 {
                if c >= b'0' && c <= b'9' {
                    c - b'0'
                } else if c >= b'A' && c <= b'F' {
                    c - b'A' + 10
                } else if c >= b'a' && c <= b'f' {
                    c - b'a' + 10
                } else {
                    0
                }
            };
            result.push((val(hi) << 4) | val(lo));
        } else if b == b'+' {
            result.push(b' ');
        } else {
            result.push(b);
        }
    }
    String::from_utf8_lossy(&result).into_owned()
}

fn guess_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        _ => "application/octet-stream",
    }
}
