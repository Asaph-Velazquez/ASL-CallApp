import { useEffect, useState } from 'react';

type Props = { selected: string; busy: boolean; onSelect: (id: string) => Promise<void> };

export default function CameraOptions({ selected, busy, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState('');
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const devices = navigator.mediaDevices;
    const refresh = async () => {
      try {
        if (!devices?.enumerateDevices) throw new Error('Camera detection requires HTTPS or localhost and a supported browser.');
        const available = await devices.enumerateDevices();
        if (!cancelled) { setCameras(available.filter(device => device.kind === 'videoinput')); setError(''); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unable to detect cameras.');
      }
    };
    void refresh();
    devices?.addEventListener('devicechange', refresh);
    return () => { cancelled = true; devices?.removeEventListener('devicechange', refresh); };
  }, [open, selected]);

  async function detect() {
    setDetecting(true);
    setError('');
    let permissionStream: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Use HTTPS or localhost to enable camera access.');
      // Only request permission on an explicit click, before a call has a camera.
      if (!selected) permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      setCameras((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Allow camera access in your browser settings.');
    } finally {
      permissionStream?.getTracks().forEach(track => track.stop());
      setDetecting(false);
    }
  }

  return <div className="camera-options">
    <button type="button" className="ghost-button" aria-expanded={open} aria-controls="camera-options-panel" onClick={() => setOpen(!open)}>
      Camera options
    </button>
    {open && <div id="camera-options-panel" className="camera-options-panel">
      <label className="field">
        <span>Camera device</span>
        <select aria-label="Camera device" value={selected} disabled={busy || detecting || !cameras.length}
          onChange={event => { void onSelect(event.target.value); }}>
          <option value="" disabled>Select a camera</option>
          {selected && !cameras.some(camera => camera.deviceId === selected) && <option value={selected}>Current camera (not detected)</option>}
          {cameras.filter(camera => camera.deviceId).map((camera, index) =>
            <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `Camera ${index + 1}`}</option>)}
        </select>
      </label>
      <p>{cameras.length ? `${cameras.length} camera(s) detected. Choose the one to use for this call.` : 'No cameras detected. Connect a camera and allow camera access.'}</p>
      <button type="button" className="ghost-button" disabled={busy || detecting} onClick={() => void detect()}>
        {detecting ? 'Detecting...' : 'Detect cameras'}
      </button>
      {error && <p role="alert" className="error-banner">{error}</p>}
    </div>}
  </div>;
}
