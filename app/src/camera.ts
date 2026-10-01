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
