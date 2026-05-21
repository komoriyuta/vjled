use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

const CMD_SET_PIXEL_RANGE: u8 = 0x00;
const CMD_FILL_COLOR: u8 = 0x01;
const CMD_SHOW: u8 = 0x02;
const CMD_PING: u8 = 0xFF;

const HEADER_SIZE: usize = 9;
const MAX_PIXELS_PER_PACKET: usize = 255;

pub struct NeoPixelProtocol {
    socket: UdpSocket,
    frame_no: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UdpSendReport {
    pub target: String,
    pub local_addr: String,
    pub bytes: usize,
    pub command: u8,
    pub device_id: u16,
    pub frame_no: u32,
}

impl NeoPixelProtocol {
    pub fn new() -> Result<Self, String> {
        let socket = UdpSocket::bind("0.0.0.0:0")
            .map_err(|e| format!("Failed to bind UDP socket: {}", e))?;
        socket
            .set_broadcast(true)
            .map_err(|e| format!("Failed to set broadcast: {}", e))?;
        Ok(Self { socket, frame_no: 0 })
    }

    fn next_frame_no(&mut self) -> u32 {
        let n = self.frame_no;
        self.frame_no = self.frame_no.wrapping_add(1);
        n
    }

    fn build_header(
        &self,
        device_id: u16,
        command: u8,
        flags: u8,
        frame_no: u32,
        count: u8,
    ) -> [u8; HEADER_SIZE] {
        let mut buf = [0u8; HEADER_SIZE];
        buf[0..2].copy_from_slice(&device_id.to_le_bytes());
        buf[2] = command;
        buf[3] = flags;
        buf[4..8].copy_from_slice(&frame_no.to_le_bytes());
        buf[8] = count;
        buf
    }

    fn send_to(&self, data: &[u8], target: &SocketAddrV4) -> Result<usize, String> {
        self.socket
            .send_to(data, target)
            .map_err(|e| format!("UDP send failed: {}", e))
    }

    fn send_report(
        &self,
        data: &[u8],
        target: &SocketAddrV4,
        command: u8,
        device_id: u16,
        frame_no: u32,
    ) -> Result<UdpSendReport, String> {
        let bytes = self.send_to(data, target)?;
        let local_addr = self
            .socket
            .local_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        Ok(UdpSendReport {
            target: target.to_string(),
            local_addr,
            bytes,
            command,
            device_id,
            frame_no,
        })
    }

    fn resolve_addr(ip: &str, port: u16) -> Result<SocketAddrV4, String> {
        let addr: Ipv4Addr = ip.parse().map_err(|e| format!("Invalid IP '{}': {}", ip, e))?;
        Ok(SocketAddrV4::new(addr, port))
    }

    pub fn send_set_pixel_range_to(
        &mut self,
        device_id: u16,
        start: u16,
        pixels: &[(u8, u8, u8)],
        target_ip: &str,
        port: u16,
    ) -> Result<(), String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        for (chunk_index, chunk) in pixels.chunks(MAX_PIXELS_PER_PACKET).enumerate() {
            let chunk_start = start
                .checked_add((chunk_index * MAX_PIXELS_PER_PACKET) as u16)
                .ok_or("Pixel range start overflow")?;
            let count = chunk.len() as u8;
            let frame_no = self.next_frame_no();
            let header = self.build_header(device_id, CMD_SET_PIXEL_RANGE, 0, frame_no, count);

            let mut buf = Vec::with_capacity(HEADER_SIZE + 3 + chunk.len() * 3);
            buf.extend_from_slice(&header);
            buf.extend_from_slice(&chunk_start.to_le_bytes());
            buf.push(count);
            for (r, g, b) in chunk {
                buf.push(*r);
                buf.push(*g);
                buf.push(*b);
            }
            self.send_to(&buf, &addr)?;
        }
        Ok(())
    }

    pub fn send_fill_color_to(
        &mut self,
        device_id: u16,
        r: u8,
        g: u8,
        b: u8,
        target_ip: &str,
        port: u16,
    ) -> Result<(), String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_FILL_COLOR, 0, frame_no, 1);

        let mut buf = Vec::with_capacity(HEADER_SIZE + 3);
        buf.extend_from_slice(&header);
        buf.push(r);
        buf.push(g);
        buf.push(b);
        self.send_to(&buf, &addr)?;
        Ok(())
    }

    pub fn send_fill_color_report_to(
        &mut self,
        device_id: u16,
        r: u8,
        g: u8,
        b: u8,
        target_ip: &str,
        port: u16,
    ) -> Result<UdpSendReport, String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_FILL_COLOR, 0, frame_no, 1);

        let mut buf = Vec::with_capacity(HEADER_SIZE + 3);
        buf.extend_from_slice(&header);
        buf.push(r);
        buf.push(g);
        buf.push(b);
        self.send_report(&buf, &addr, CMD_FILL_COLOR, device_id, frame_no)
    }

    pub fn send_show_to(
        &mut self,
        device_id: u16,
        target_ip: &str,
        port: u16,
    ) -> Result<(), String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_SHOW, 0, frame_no, 0);
        self.send_to(&header, &addr)?;
        Ok(())
    }

    pub fn send_show_report_to(
        &mut self,
        device_id: u16,
        target_ip: &str,
        port: u16,
    ) -> Result<UdpSendReport, String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_SHOW, 0, frame_no, 0);
        self.send_report(&header, &addr, CMD_SHOW, device_id, frame_no)
    }

    pub fn send_ping_to(
        &mut self,
        device_id: u16,
        target_ip: &str,
        port: u16,
    ) -> Result<(), String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_PING, 0, frame_no, 0);
        self.send_to(&header, &addr)?;
        Ok(())
    }

    pub fn send_ping_report_to(
        &mut self,
        device_id: u16,
        target_ip: &str,
        port: u16,
    ) -> Result<UdpSendReport, String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_PING, 0, frame_no, 0);
        self.send_report(&header, &addr, CMD_PING, device_id, frame_no)
    }
}
