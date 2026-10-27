type CaptureDevices = Pick<MediaDevices, 'getUserMedia'>;

export async function captureCallMedia(devices: CaptureDevices, deviceId = '') {
  // Desktop cameras need no facingMode; ask the system for its default camera.
  if (!deviceId) return devices.getUserMedia({ video: true, audio: true });

  try {
    return await devices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: true });
  } catch (cause) {
    const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw cause;
    // A disconnected camera or a changed device ID must not block the next call.
    return devices.getUserMedia({ video: true, audio: true });
  }
}

export function mediaCaptureErrorMessage(cause: unknown) {
  const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Allow ASL Interpreter in macOS System Settings > Privacy & Security > Camera and Microphone (or your browser site settings). If macOS requests it, quit and reopen the app, then retry media.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'A camera or microphone is missing or unavailable. Connect both devices, check that macOS or your browser can detect them, then retry media.';
  }
  if (name === 'NotReadableError') {
    return 'Camera or microphone is unavailable. Close other apps using it and retry media.';
  }
  return cause instanceof Error ? cause.message : 'Unable to access camera and microphone.';
}

export async function replaceCamera(
  devices: Pick<MediaDevices, 'getUserMedia'>,
  stream: MediaStream,
  connection: RTCPeerConnection | null,
  deviceId: string,
  isCurrent: () => boolean,
) {
  const replacement = await devices.getUserMedia({ video: { deviceId: { exact: deviceId } }, audio: false });
  const track = replacement.getVideoTracks()[0];
  let installed = false;
  try {
    if (!track) throw new Error('The selected camera did not provide a video track.');
    if (!isCurrent()) return;
    const previous = stream.getVideoTracks();
    track.enabled = previous[0]?.enabled ?? true;
    const sender = connection?.getSenders().find(entry => entry.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
    if (!isCurrent()) return;
    stream.addTrack(track);
    previous.forEach(old => { stream.removeTrack(old); old.stop(); });
    installed = true;
  } finally {
    if (!installed) replacement.getTracks().forEach(item => item.stop());
  }
}
