import { useCallback, useEffect, useRef, useState } from 'react';
import exifr from 'exifr';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Metadata = Record<string, any>;
type Photo = { file: File; data: Metadata | null; previewUrl: string; error?: string; loading?: boolean };

const PARSE_OPTIONS = { tiff: true, xmp: true, icc: true, iptc: true, jfif: true, ihdr: true, gps: true, reviveValues: true };

function formatBytes(bytes: number) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(2))} ${units[i]}`;
}

function cleanJson(data: Metadata) {
  return JSON.stringify(data, (_key, value) => value instanceof Uint8Array || value instanceof ArrayBuffer ? `[Binary Buffer (${value.byteLength} bytes)]` : value, 2);
}

function dateValue(data: Metadata | null) {
  const value = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate;
  if (!value) return 'N/A';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function dimensions(data: Metadata | null) {
  const width = data?.ExifImageWidth || data?.ImageWidth || data?.rawImageWidth;
  const height = data?.ExifImageHeight || data?.ImageHeight || data?.rawImageHeight;
  return width && height ? `${width} × ${height} px` : 'N/A';
}

function exposure(data: Metadata | null) {
  const value = data?.ExposureTime;
  return typeof value === 'number' ? value < 1 ? `1/${Math.round(1 / value)}s` : `${value}s` : 'N/A';
}

async function parseBatch(files: File[]) {
  const result: Photo[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      const previewUrl = URL.createObjectURL(file);
      try {
        const data = await exifr.parse(file, PARSE_OPTIONS);
        result[index] = { file, data: data || {}, previewUrl };
      } catch (error) {
        result[index] = { file, data: null, previewUrl, error: error instanceof Error ? error.message : 'Unsupported or corrupted file.' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, files.length) }, worker));
  return result;
}

function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('');
  const [address, setAddress] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/') || /\.(heic|heif|tiff|webp)$/i.test(file.name));
    if (!imageFiles.length) { setStatus('No supported image files were found.'); return; }
    const start = photos.length;
    const placeholders = imageFiles.map(file => ({ file, data: null, previewUrl: URL.createObjectURL(file), loading: true }));
    setPhotos(prev => [...prev, ...placeholders]);
    setSelected(start);
    setStatus(`Reading ${imageFiles.length} photo${imageFiles.length === 1 ? '' : 's'}...`);
    const processed = await parseBatch(imageFiles);
    setPhotos(prev => {
      const next = [...prev];
      processed.forEach((item, i) => { if (next[start + i]) { URL.revokeObjectURL(next[start + i].previewUrl); next[start + i] = item; } });
      return next;
    });
    setStatus(`${processed.length} photo${processed.length === 1 ? '' : 's'} loaded.`);
  }, [photos.length]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); void processFiles(files); }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [processFiles]);

  const photo = photos[selected];
  const data = photo?.data;
  const hasGps = typeof data?.latitude === 'number' && typeof data?.longitude === 'number';

  useEffect(() => {
    if (!mapRef.current || !hasGps) { mapInstance.current?.remove(); mapInstance.current = null; marker.current = null; return; }
    const lat = data!.latitude as number, lon = data!.longitude as number;
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([lat, lon], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapInstance.current);
      marker.current = L.marker([lat, lon]).addTo(mapInstance.current);
    } else { mapInstance.current.setView([lat, lon], 14); marker.current?.setLatLng([lat, lon]); mapInstance.current.invalidateSize(); }
  }, [selected, hasGps, data]);

  useEffect(() => {
    setAddress('');
    if (!hasGps) return;
    const controller = new AbortController();
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${data!.latitude}&lon=${data!.longitude}&zoom=18&addressdetails=1`, { headers: { 'Accept-Language': 'en' }, signal: controller.signal })
      .then(response => response.json()).then(result => setAddress(result.display_name || 'Coordinates found; location unavailable.')).catch(() => setAddress('Coordinates found; reverse geocoding unavailable.'));
    return () => controller.abort();
  }, [selected, hasGps, data]);

  const exportJson = () => {
    if (!data || !photo) return;
    const url = URL.createObjectURL(new Blob([cleanJson(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `exif_report_${photo.file.name.replace(/\.[^/.]+$/, '')}.json`; a.click(); URL.revokeObjectURL(url);
  };

  const stripExif = () => {
    if (!photo) return;
    const img = new Image();
    img.onload = () => { const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d'); if (!ctx) return; ctx.drawImage(img, 0, 0); canvas.toBlob(blob => { if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `clean_${photo.file.name.replace(/\.[^/.]+$/, '')}.jpg`; a.click(); URL.revokeObjectURL(url); }, 'image/jpeg', .92); };
    img.src = photo.previewUrl;
  };

  const removePhoto = (index: number) => { setPhotos(prev => { const removed = prev[index]; if (removed) URL.revokeObjectURL(removed.previewUrl); const next = prev.filter((_, i) => i !== index); setSelected(current => Math.min(current > index ? current - 1 : current, Math.max(0, next.length - 1))); return next; }); };
  const clearAll = () => { photos.forEach(item => URL.revokeObjectURL(item.previewUrl)); mapInstance.current?.remove(); mapInstance.current = null; marker.current = null; setPhotos([]); setSelected(0); setStatus(''); setAddress(''); };

  return <div className="page"><div className="shell">
    <header className="neo header"><div><span className="eyebrow">CLIENT-SIDE // MOBILE-READY</span><h1>EXIF INSPECTOR</h1><p>Cross-platform metadata decoder for Android, iOS & Desktop.</p></div><div className="badges"><span>HEIC</span><span>JPEG</span><span>TIFF</span><span>PNG</span></div></header>
    <section className={`neo upload ${dragging ? 'active' : ''}`} onClick={() => inputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void processFiles(e.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept="image/*,.heic,.heif,.tiff,.webp" multiple hidden onChange={e => { if (e.target.files) void processFiles(e.target.files); e.currentTarget.value = ''; }} />
      <div className="plus">+</div><h2>CHOOSE OR DROP PHOTOS</h2><p>Paste with ⌘V / Ctrl+V · Multiple files supported · Files remain 100% local.</p>
    </section>
    {status && <div className="neo status">⚠️ <span>{status}</span></div>}
    {photos.length > 0 && <main className="content">
      <div className="toolbar"><button className="btn violet" onClick={exportJson}>💾 SAVE FULL JSON REPORT</button><button className="btn green" onClick={stripExif}>🛡️ DOWNLOAD PRIVACY COPY</button><button className="btn red" onClick={clearAll}>✕ CLEAR ALL</button></div>
      <section className="neo queue"><div className="queue-head"><strong>PHOTO QUEUE</strong><div className="queue-actions"><span>{photos.length} LOADED</span><button className="queue-btn" onClick={() => inputRef.current?.click()}>+ ADD MORE</button></div></div><div className="thumbs">{photos.map((item, i) => <div className={`thumb-wrap ${i === selected ? 'selected' : ''}`} key={`${item.file.name}-${i}`}><button className="thumb" onClick={() => setSelected(i)}><img src={item.previewUrl} alt=""/><span>{i + 1}</span></button><button className="remove-thumb" onClick={() => removePhoto(i)}>×</button></div>)}</div></section>
      <section className="neo batch"><div className="card-head"><h3>▦ ALL PHOTOS — METADATA OVERVIEW</h3><span>{photos.reduce((n, item) => n + Object.keys(item.data || {}).length, 0)} TAGS</span></div><div className="batch-grid">{photos.map((item, i) => <button className={`batch-item ${i === selected ? 'selected' : ''}`} key={`batch-${item.file.name}-${i}`} onClick={() => setSelected(i)}><img src={item.previewUrl} alt=""/><div className="batch-info"><strong>{item.file.name}</strong><span>{formatBytes(item.file.size)} · {item.loading ? 'READING...' : `${Object.keys(item.data || {}).length} tags`}</span><span>{item.data?.Make || 'Unknown make'} {item.data?.Model || ''}</span><span>{dateValue(item.data)}</span><span>{typeof item.data?.latitude === 'number' ? '📍 GPS' : '○ No GPS'}</span></div></button>)}</div></section>
      {photo && <>
        <section className="neo card"><div className="card-head"><h3>▣ PHOTO PREVIEW & METADATA</h3><span>{formatBytes(photo.file.size)}</span></div><div className="preview-grid"><div className="preview"><img src={photo.previewUrl} alt={photo.file.name} /></div><div className="facts"><Fact label="FILE NAME" value={photo.file.name}/><div className="two"><Fact label="MIME TYPE" value={photo.file.type || 'binary image'}/><Fact label="IMAGE DIMENSIONS" value={dimensions(data)}/></div><Fact label="TIMESTAMP (ORIGINAL)" value={dateValue(data)}/><div className="two"><Fact label="ORIENTATION" value={data?.Orientation ? String(data.Orientation) : 'N/A'}/><Fact label="SOFTWARE" value={data?.Software || 'N/A'}/></div></div></div></section>
        <div className="columns"><section className="neo card"><div className="card-head"><h3>◉ GEOLOCATION TELEMETRY</h3><span className={hasGps ? 'good' : 'bad'}>{hasGps ? 'GPS ACTIVE' : 'NO GPS FOUND'}</span></div><div className="two"><Fact label="LATITUDE" value={hasGps ? data!.latitude.toFixed(6) : 'NOT EMBEDDED'}/><Fact label="LONGITUDE" value={hasGps ? data!.longitude.toFixed(6) : 'NOT EMBEDDED'}/><Fact label="ALTITUDE" value={typeof data?.GPSAltitude === 'number' ? `${data.GPSAltitude.toFixed(1)} m` : 'N/A'}/><Fact label="GPS TIMESTAMP" value={data?.GPSTimeStamp ? String(data.GPSTimeStamp) : 'N/A'}/></div>{hasGps && <><div ref={mapRef} className="map"/><div className="address">{address || 'Resolving location...'}</div><Fact label="MAPS LINK" value="External Map ↗" href={`https://www.google.com/maps?q=${data!.latitude},${data!.longitude}`}/></>}</section>
        <section className="neo card pink"><div className="card-head"><h3>● OPTICAL PROFILE</h3></div><div className="specs"><Fact label="MAKE" value={data?.Make || 'N/A'}/><Fact label="MODEL" value={data?.Model || 'N/A'}/><Fact label="LENS" value={data?.LensModel || data?.LensInfo || 'N/A'}/><Fact label="APERTURE" value={data?.FNumber ? `ƒ/${data.FNumber}` : 'N/A'}/><Fact label="SHUTTER" value={exposure(data)}/><Fact label="ISO" value={data?.ISO || data?.ISOSpeedRatings || 'N/A'}/><Fact label="FOCAL LENGTH" value={data?.FocalLength ? `${data.FocalLength} mm` : 'N/A'}/><Fact label="FLASH" value={data?.Flash || 'N/A'}/><Fact label="COLOR SPACE" value={data?.ColorSpace === 1 ? 'sRGB' : data?.ColorSpace || 'Uncalibrated'}/><Fact label="WHITE BALANCE" value={data?.WhiteBalance || 'N/A'}/><Fact label="METERING" value={data?.MeteringMode || 'N/A'}/><Fact label="EXPOSURE MODE" value={data?.ExposureMode || 'N/A'}/></div></section></div>
        <section className="neo raw"><div className="card-head"><h3>◆ RAW EXIF METADATA DICTIONARY</h3><span>{Object.keys(data || {}).length} TAGS PARSED</span></div><pre>{data ? cleanJson(data) : photo.error || 'No metadata records detected.'}</pre></section>
      </>}
    </main>}
  </div></div>;
}
function Fact({ label, value, href }: { label: string; value: string; href?: string }) { return <div className="fact"><small>{label}</small>{href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <strong>{value}</strong>}</div>; }
export default App;
