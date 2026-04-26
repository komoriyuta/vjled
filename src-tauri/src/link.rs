use ableton_link::Link;
use serde::{Deserialize, Serialize};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEFAULT_BPM: f64 = 120.0;
const DEFAULT_QUANTUM: f64 = 4.0;
const TICK: Duration = Duration::from_millis(33);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub enabled: bool,
    pub start_stop_sync: bool,
    pub bpm: f64,
    pub beat: f64,
    pub phase: f64,
    pub quantum: f64,
    pub peers: usize,
    pub playing: bool,
    pub micros: i64,
}

impl Default for LinkStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            start_stop_sync: true,
            bpm: DEFAULT_BPM,
            beat: 0.0,
            phase: 0.0,
            quantum: DEFAULT_QUANTUM,
            peers: 0,
            playing: true,
            micros: 0,
        }
    }
}

pub struct LinkController {
    tx: Sender<LinkCommand>,
    latest: Arc<Mutex<LinkStatus>>,
}

impl LinkController {
    pub fn spawn(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        let latest = Arc::new(Mutex::new(LinkStatus::default()));
        let worker_latest = Arc::clone(&latest);
        thread::spawn(move || run_link_worker(app, rx, worker_latest));
        Self { tx, latest }
    }

    pub fn configure(
        &self,
        enabled: bool,
        start_stop_sync: bool,
        quantum: f64,
    ) -> Result<LinkStatus, String> {
        self.send(LinkCommand::Configure {
            enabled,
            start_stop_sync,
            quantum: sanitize_quantum(quantum),
        })?;
        self.status()
    }

    pub fn set_tempo(&self, bpm: f64) -> Result<LinkStatus, String> {
        self.send(LinkCommand::SetTempo(sanitize_bpm(bpm)))?;
        self.status()
    }

    pub fn set_playing(&self, playing: bool) -> Result<LinkStatus, String> {
        self.send(LinkCommand::SetPlaying(playing))?;
        self.status()
    }

    pub fn status(&self) -> Result<LinkStatus, String> {
        self.latest.lock().map(|s| s.clone()).map_err(|e| e.to_string())
    }

    fn send(&self, command: LinkCommand) -> Result<(), String> {
        self.tx
            .send(command)
            .map_err(|e| format!("Ableton Link worker is not running: {}", e))
    }
}

enum LinkCommand {
    Configure {
        enabled: bool,
        start_stop_sync: bool,
        quantum: f64,
    },
    SetTempo(f64),
    SetPlaying(bool),
}

fn run_link_worker(app: AppHandle, rx: Receiver<LinkCommand>, latest: Arc<Mutex<LinkStatus>>) {
    let mut link = Link::new(DEFAULT_BPM);
    link.enable_start_stop_sync(true);
    let mut quantum = DEFAULT_QUANTUM;
    let mut last_emitted = LinkStatus::default();

    loop {
        while let Ok(command) = rx.try_recv() {
            match command {
                LinkCommand::Configure {
                    enabled,
                    start_stop_sync,
                    quantum: next_quantum,
                } => {
                    quantum = next_quantum;
                    link.enable_start_stop_sync(start_stop_sync);
                    link.enable(enabled);
                }
                LinkCommand::SetTempo(bpm) => {
                    let now = link.clock().micros();
                    let mut next = None;
                    link.with_app_session_state(|mut session| {
                        session.set_tempo(bpm, now);
                        next = Some(session);
                    });
                    if let Some(session) = next {
                        link.commit_app_session_state(session);
                    }
                }
                LinkCommand::SetPlaying(playing) => {
                    let now = link.clock().micros();
                    let mut next = None;
                    link.with_app_session_state(|mut session| {
                        session.set_is_playing_and_request_beat_at_time(
                            playing,
                            now,
                            0.0,
                            quantum,
                        );
                        next = Some(session);
                    });
                    if let Some(session) = next {
                        link.commit_app_session_state(session);
                    }
                }
            }
        }

        let now = link.clock().micros();
        let mut status = LinkStatus {
            enabled: link.is_enabled(),
            start_stop_sync: link.is_start_stop_sync_enabled(),
            quantum,
            peers: link.num_peers(),
            micros: now,
            ..last_emitted.clone()
        };
        link.with_app_session_state(|session| {
            status.bpm = session.tempo();
            status.beat = session.beat_at_time(now, quantum);
            status.phase = session.phase_at_time(now, quantum);
            status.playing = session.is_playing();
        });

        if let Ok(mut slot) = latest.lock() {
            *slot = status.clone();
        }
        if should_emit(&last_emitted, &status) {
            let _ = app.emit("link-state", &status);
            last_emitted = status;
        }
        thread::sleep(TICK);
    }
}

fn should_emit(prev: &LinkStatus, next: &LinkStatus) -> bool {
    prev.enabled != next.enabled
        || prev.start_stop_sync != next.start_stop_sync
        || prev.peers != next.peers
        || prev.playing != next.playing
        || (prev.bpm - next.bpm).abs() >= 0.01
        || (prev.beat - next.beat).abs() >= 0.01
        || (prev.phase - next.phase).abs() >= 0.01
        || (prev.quantum - next.quantum).abs() >= 0.001
}

fn sanitize_bpm(bpm: f64) -> f64 {
    if bpm.is_finite() {
        bpm.clamp(20.0, 999.0)
    } else {
        DEFAULT_BPM
    }
}

fn sanitize_quantum(quantum: f64) -> f64 {
    if quantum.is_finite() {
        quantum.clamp(1.0, 64.0)
    } else {
        DEFAULT_QUANTUM
    }
}
