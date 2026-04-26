use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

const CMD_SET_PIXEL_RANGE: u8 = 0x00;
const CMD_FILL_COLOR: u8 = 0x01;
const CMD_SHOW: u8 = 0x02;
const CMD_PING: u8 = 0xFF;

const HEADER_SIZE: usize = 8;
const MAX_PIXELS_PER_PACKET: usize = 255;

pub struct NeoPixelProtocol {
    socket: UdpSocket,
    frame_no: u32,
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

    fn build_header(&self, device_id: u16, command: u8, flags: u8, frame_no: u32) -> [u8; HEADER_SIZE] {
        let mut buf = [0u8; HEADER_SIZE];
        buf[0..2].copy_from_slice(&device_id.to_le_bytes());
        buf[2] = command;
        buf[3] = flags;
        buf[4..8].copy_from_slice(&frame_no.to_le_bytes());
        buf
    }

    fn send_to(&self, data: &[u8], target: &SocketAddrV4) -> Result<(), String> {
        self.socket
            .send_to(data, target)
            .map_err(|e| format!("UDP send failed: {}", e))?;
        Ok(())
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
        for chunk in pixels.chunks(MAX_PIXELS_PER_PACKET) {
            let count = chunk.len() as u8;
            let frame_no = self.next_frame_no();
            let header = self.build_header(device_id, CMD_SET_PIXEL_RANGE, 0, frame_no);

            let mut buf = Vec::with_capacity(HEADER_SIZE + 3 + chunk.len() * 3);
            buf.extend_from_slice(&header);
            buf.extend_from_slice(&start.to_le_bytes());
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
        let header = self.build_header(device_id, CMD_FILL_COLOR, 0, frame_no);

        let mut buf = Vec::with_capacity(HEADER_SIZE + 3);
        buf.extend_from_slice(&header);
        buf.push(r);
        buf.push(g);
        buf.push(b);
        self.send_to(&buf, &addr)
    }

    pub fn send_show_to(
        &mut self,
        device_id: u16,
        target_ip: &str,
        port: u16,
    ) -> Result<(), String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_SHOW, 0, frame_no);
        self.send_to(&header, &addr)
    }

    pub fn send_ping_to(
        &mut self,
        device_id: u16,
        target_ip: &str,
        port: u16,
    ) -> Result<(), String> {
        let addr = Self::resolve_addr(target_ip, port)?;
        let frame_no = self.next_frame_no();
        let header = self.build_header(device_id, CMD_PING, 0, frame_no);
        self.send_to(&header, &addr)
    }
}
