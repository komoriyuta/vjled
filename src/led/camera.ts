import { invoke } from "@tauri-apps/api/core";

export async function prepareCameraWindow(): Promise<void> {
  try {
    await invoke("camera_prepare_window");
  } catch (e) {
    console.warn("Failed to prepare camera permissions:", e);
  }
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraStartOptions {
  width?: number;
  height?: number;
  frameRate?: number;
}

export async function listCalibrationCameras(): Promise<CameraDevice[]> {
  await prepareCameraWindow();

  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error("Camera listing is unavailable in this WebView.");
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "videoinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    }));
}

export async function startCalibrationCamera(
  deviceId?: string | null,
  options: CameraStartOptions = {},
): Promise<MediaStream> {
  await prepareCameraWindow();

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera API is unavailable in this WebView. On Linux, install WebKitGTK with media stream support and restart VJLED.",
    );
  }

  try {
    const selectedDevice = deviceId ? { exact: deviceId } : undefined;
    const width = options.width ?? 640;
    const height = options.height ?? 480;
    const frameRate = options.frameRate ?? 30;
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(selectedDevice ? { deviceId: selectedDevice } : {}),
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: frameRate, max: frameRate },
      },
    });
  } catch (e) {
    if (deviceId && e instanceof DOMException && e.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId } } });
    }
    throw new Error(formatCameraError(e));
  }
}

export async function attachCameraStream(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<string> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });
  }

  await video.play();
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings();
  const label = track?.label || "camera";
  const width = settings?.width ?? video.videoWidth;
  const height = settings?.height ?? video.videoHeight;
  return `${label} ${width || "?"}x${height || "?"}`;
}

function formatCameraError(error: unknown): string {
  if (!(error instanceof DOMException)) return String(error);

  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission was denied. Check OS camera privacy settings and make sure VJLED is allowed to use the camera.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera was found. Check that the camera is connected and visible as a video device.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is already in use or cannot be opened. Close other camera apps and try again.";
    case "OverconstrainedError":
      return "The camera does not support the requested resolution. Try another camera or lower its capture mode.";
    case "SecurityError":
      return "The WebView blocked camera access. Restart the app; Linux builds now explicitly allow camera permissions.";
    default:
      return `${error.name}: ${error.message}`;
  }
}
