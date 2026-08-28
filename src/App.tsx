import { useCallback, useEffect, useRef, useState } from 'react';
import exifr from 'exifr';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Metadata = Record<string, any>;
type Photo = { file: File; data: Metadata | null; previewUrl: string; error?: string };

function formatBytes(bytes: number) {
  if (!bytes) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** i).toFixed(2))} ${units[i]}`;
}

function cleanJson(data: Metadata) {
  return JSON.stringify(data, (_key, value) => {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[Binary Buffer (${value.byteLength} bytes)]`;
    return value;
  }, 2);
}

function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selected, setSelected] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/') || /\.(heic|heif|tiff|webp)$/i.test(file.name));
    if (!imageFiles.length) { setStatus('No supported image files were found.'); return; }
    setStatus(`Processing ${imageFiles.length} photo${imageFiles.length === 1 ? '' : 's'}...`);
    const processed = await Promise.all(imageFiles.map(async file => {
      const previewUrl = URL.createObjectURL(file);
      try {
        const data = await exifr.parse(file, { tiff: true, xmp: true, icc: true, jfif: true, ihdr: true, gps: true, reviveValues: true });
        return { file, data: data || {}, previewUrl };
      } catch (error) {
        return { file, data: null, previewUrl, error: error instanceof Error ? error.message : 'Unsupported or corrupted file.' };
      }
    }));
    setPhotos(prev => {
      setSelected(prev.length);
      return [...prev, ...processed];
    });
    setStatus(`${processed.length} photo${processed.length === 1 ? '' : 's'} loaded.`);
  }, []);

  useEffect(() => () => photos.forEach(photo => URL.revokeObjectURL(photo.previewUrl)), [photos]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
      if (files.length) { event.preventDefault(); processFiles(files); }
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, [processFiles]);

  const photo = photos[selected];
  const data = photo?.data;
  const hasGps = typeof data?.latitude === 'number' && typeof data?.longitude === 'number';

  useEffect(() => {
    if (!mapRef.current || !hasGps) { mapInstance.current?.remove(); mapInstance.current = null; marker.current = null; return; }
    const lat = data!.latitude as number;
    const lon = data!.longitude as number;
    if (!mapInstance.current) {
      mapInstance.current = L.map(mapRef.current).setView([lat, lon], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapInstance.current);
      marker.current = L.marker([lat, lon]).addTo(mapInstance.current);
    } else {
      mapInstance.current.setView([lat, lon], 14);
      marker.current?.setLatLng([lat, lon]);
      mapInstance.current.invalidateSize();
    }
  }, [selected, hasGps, data]);

  const exportJson = () => {
    if (!data || !photo) return;
    const blob = new Blob([cleanJson(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `exif_report_${photo.file.name.replace(/\.[^/.]+$/, '')}.json`; a.click(); URL.revokeObjectURL(url);
  };

  const stripExif = () => {
    if (!photo) return;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        a.href = url; a.download = `clean_${photo.file.name.replace(/\.[^/.]+$/, '')}.jpg`; a.click(); URL.revokeObjectURL(url);
      }, 'image/jpeg', .92);
    };
    img.src = photo.previewUrl;
  };

  return <div className="page"><div className="shell">
    <header className="neo header"><div><span className="eyebrow">CLIENT-SIDE // MOBILE-READY</span><h1>EXIF INSPECTOR</h1><p>Cross-platform metadata decoder for Android, iOS & Desktop.</p></div><div className="badges"><span>HEIC</span><span>JPEG</span><span>TIFF</span><span>PNG</span></div></header>
    <section className={`neo upload ${dragging ? 'active' : ''}`} onClick={() => inputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept="image/*,.heic,.heif,.tiff,.webp" multiple hidden onChange={e => e.target.files && processFiles(e.target.files)} />
      <div className="plus">+</div><h2>CHOOSE OR DROP PHOTOS</h2><p>Paste with ⌘V / Ctrl+V · Multiple files supported · Files remain 100% local.</p>
    </section>
    {status && <div className="neo status">⚠️ <span>{status}</span></div>}
    {photos.length > 0 && <main className="content">
      <div className="toolbar"><button className="btn violet" onClick={exportJson}>💾 SAVE FULL JSON REPORT</button><button className="btn green" onClick={stripExif}>🛡️ DOWNLOAD PRIVACY COPY</button></div>
      <div className="neo queue"><div className="queue-head"><strong>PHOTO QUEUE</strong><span>{photos.length} LOADED</span></div><div className="thumbs">{photos.map((item, i) => <button className={`thumb ${i === selected ? 'selected' : ''}`} key={`${item.file.name}-${i}`} onClick={() => setSelected(i)}><img src={item.previewUrl} alt=""/><span>{i + 1}</span></button>)}</div></div>
      {photo && <>
        <section className="neo card"><div className="card-head"><h3>▣ PHOTO PREVIEW & METADATA</h3><span>{formatBytes(photo.file.size)}</span></div><div className="preview-grid"><div className="preview"><img src={photo.previewUrl} alt={photo.file.name} onError={e => e.currentTarget.style.display='none'} /></div><div className="facts"><Fact label="FILE NAME" value={photo.file.name}/><div className="two"><Fact label="MIME TYPE" value={photo.file.type || 'image/heic (binary)'}/><Fact label="IMAGE DIMENSIONS" value={data ? `${data.ExifImageWidth || data.ImageWidth || data.rawImageWidth || '?'} × ${data.ExifImageHeight || data.ImageHeight || data.rawImageHeight || '?'} px` : 'N/A'}/></div><Fact label="TIMESTAMP (ORIGINAL)" value={data?.DateTimeOriginal ? new Date(data.DateTimeOriginal).toLocaleString() : data?.CreateDate ? new Date(data.CreateDate).toLocaleString() : 'N/A'}/></div></div></section>
        <div className="columns"><section className="neo card"><div className="card-head"><h3>◉ GEOLOCATION TELEMETRY</h3><span className={hasGps ? 'good' : 'bad'}>{hasGps ? 'GPS ACTIVE' : 'NO GPS FOUND'}</span></div><div className="two"><Fact label="LATITUDE" value={hasGps ? data!.latitude.toFixed(6) : 'NOT EMBEDDED'}/><Fact label="LONGITUDE" value={hasGps ? data!.longitude.toFixed(6) : 'NOT EMBEDDED'}/><Fact label="ALTITUDE" value={hasGps && typeof data?.GPSAltitude === 'number' ? `${data.GPSAltitude.toFixed(1)} m` : 'N/A'}/><Fact label="MAPS LINK" value={hasGps ? 'External Map ↗' : 'N/A'} href={hasGps ? `https://www.google.com/maps?q=${data!.latitude},${data!.longitude}` : undefined}/></div>{hasGps && <div ref={mapRef} className="map"/>}</section>
        <section className="neo card pink"><div className="card-head"><h3>● OPTICAL PROFILE</h3></div><div className="specs"><Fact label="MAKE" value={data?.Make || 'N/A'}/><Fact label="MODEL" value={data?.Model || 'N/A'}/><Fact label="LENS" value={data?.LensModel || data?.LensInfo || 'N/A'}/><Fact label="APERTURE" value={data?.FNumber ? `ƒ/${data.FNumber}` : 'N/A'}/><Fact label="SHUTTER" value={data?.ExposureTime ? data.ExposureTime < 1 ? `1/${Math.round(1/data.ExposureTime)}s` : `${data.ExposureTime}s` : 'N/A'}/><Fact label="ISO" value={data?.ISO || data?.ISOSpeedRatings || 'N/A'}/><Fact label="FOCAL LENGTH" value={data?.FocalLength ? `${data.FocalLength} mm` : 'N/A'}/><Fact label="FLASH" value={data?.Flash || 'N/A'}/><Fact label="COLOR SPACE" value={data?.ColorSpace === 1 ? 'sRGB' : data?.ColorSpace || 'Uncalibrated'}/></div></section></div>
        <section className="neo raw"><div className="card-head"><h3>◆ RAW EXIF METADATA DICTIONARY</h3><span>{Object.keys(data || {}).length} TAGS PARSED</span></div><pre>{data ? cleanJson(data) : photo.error || 'No metadata records detected.'}</pre></section>
      </>}
    </main>}
  </div></div>;
}

function Fact({ label, value, href }: { label: string; value: string; href?: string }) { return <div className="fact"><small>{label}</small>{href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <strong>{value}</strong>}</div>; }

export default App;
