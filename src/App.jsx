import React, { useState, useEffect, useCallback } from 'react';
import { 
  UploadCloud, 
  Clock, 
  CheckCircle, 
  Download, 
  Activity, 
  AlertCircle, 
  RefreshCw, 
  Calendar, 
  Heart,
  ArrowRight,
  ChevronRight
} from 'lucide-react';
import { Decoder, Encoder, Stream, Profile } from '@garmin/fitsdk';

function App() {
  // File State
  const [fileBuffer, setFileBuffer] = useState(null);
  const [fileName, setFileName] = useState('');
  const [originalMessages, setOriginalMessages] = useState([]);
  const [messagesGrouped, setMessagesGrouped] = useState(null);
  const [metadata, setMetadata] = useState(null);
  
  // Shift Settings State
  const [shiftDirection, setShiftDirection] = useState(1); // 1 for forward, -1 for backward
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [ms, setMs] = useState(0);
  const [customTotalMs, setCustomTotalMs] = useState(0);

  // App status State
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Get computed total shift in milliseconds
  const totalShiftMs = (hours * 3600000 + minutes * 60000 + seconds * 1000 + ms) * shiftDirection;

  // Automatically load default suunto.fit on startup
  useEffect(() => {
    loadDefaultFit();
  }, []);

  const loadDefaultFit = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      const response = await fetch('/suunto.fit');
      if (!response.ok) {
        throw new Error('Failed to fetch default suunto.fit from workspace');
      }
      const blob = await response.blob();
      const buffer = await blob.arrayBuffer();
      setFileBuffer(buffer);
      setFileName('suunto.fit (Workspace)');
      processFitBuffer(buffer);
    } catch (err) {
      console.warn('Could not load default suunto.fit:', err.message);
      setError('Could not load default suunto.fit automatically. Please drag & drop or upload a .fit file.');
    } finally {
      setIsProcessing(false);
    }
  };

  const processFitBuffer = (buffer) => {
    try {
      const stream = Stream.fromArrayBuffer(buffer);
      const decoder = new Decoder(stream);
      
      const captured = [];
      const { messages, errors } = decoder.read({
        mesgListener: (mesgNum, mesg) => {
          captured.push({ mesgNum, mesg });
        }
      });

      if (errors.length > 0) {
        console.error('Decoder non-fatal errors:', errors);
      }

      if (captured.length === 0) {
        throw new Error('No messages found in the FIT file.');
      }

      setOriginalMessages(captured);
      setMessagesGrouped(messages);
      
      // Compile metadata
      const fileId = messages.fileIdMesgs?.[0] || {};
      const records = messages.recordMesgs || [];
      const session = messages.sessionMesgs?.[0] || {};
      
      let startTime = null;
      let endTime = null;
      let avgHeartRate = 0;
      let maxHeartRate = 0;
      let hrCount = 0;
      let temperatureSum = 0;
      let tempCount = 0;

      if (records.length > 0) {
        startTime = records[0].timestamp;
        endTime = records[records.length - 1].timestamp;

        records.forEach(r => {
          if (r.heartRate) {
            avgHeartRate += r.heartRate;
            if (r.heartRate > maxHeartRate) maxHeartRate = r.heartRate;
            hrCount++;
          }
          if (r.temperature !== undefined && r.temperature !== null) {
            temperatureSum += r.temperature;
            tempCount++;
          }
        });
      } else if (session.startTime) {
        startTime = session.startTime;
        endTime = session.timestamp;
      } else if (fileId.timeCreated) {
        startTime = fileId.timeCreated;
        endTime = fileId.timeCreated;
      }

      const durationSeconds = session.totalTimerTime || 
        (startTime && endTime ? Math.round((endTime.getTime() - startTime.getTime()) / 1000) : 0);

      setMetadata({
        manufacturer: fileId.manufacturer || 'Unknown',
        productName: fileId.productName || fileId.product || 'Unknown',
        fileType: fileId.type || 'activity',
        recordCount: records.length,
        startTime: startTime,
        endTime: endTime,
        duration: durationSeconds,
        avgHeartRate: hrCount > 0 ? Math.round(avgHeartRate / hrCount) : null,
        maxHeartRate: maxHeartRate > 0 ? maxHeartRate : null,
        avgTemp: tempCount > 0 ? Math.round(temperatureSum / tempCount) : null
      });
      
      setSuccessMsg('FIT file successfully parsed & loaded!');
    } catch (err) {
      console.error(err);
      setError(`Failed to parse FIT file: ${err.message}`);
      setOriginalMessages([]);
      setMetadata(null);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError(null);
    setSuccessMsg(null);
    setIsProcessing(true);

    const reader = new FileReader();
    reader.onload = (event) => {
      const buffer = event.target?.result;
      if (buffer) {
        setFileBuffer(buffer);
        processFitBuffer(buffer);
      }
      setIsProcessing(false);
    };
    reader.onerror = () => {
      setError('File reading failed');
      setIsProcessing(false);
    };
    reader.readAsArrayBuffer(file);
  };

  // Apply time shifting helper
  const getShiftedMessages = useCallback(() => {
    if (totalShiftMs === 0) return originalMessages;

    return originalMessages.map(({ mesgNum, mesg }) => {
      // Shallow clone the message and its developerFields
      const shiftedMesg = { ...mesg };
      if (mesg.developerFields) {
        shiftedMesg.developerFields = { ...mesg.developerFields };
      }

      // Shift any Date field
      for (const key of Object.keys(shiftedMesg)) {
        const val = shiftedMesg[key];
        if (val instanceof Date) {
          shiftedMesg[key] = new Date(val.getTime() + totalShiftMs);
        }
      }

      // Shift localTimestamp if present and is number
      if (typeof shiftedMesg.localTimestamp === 'number') {
        shiftedMesg.localTimestamp += Math.round(totalShiftMs / 1000);
      }

      return { mesgNum, mesg: shiftedMesg };
    });
  }, [originalMessages, totalShiftMs]);

  const handleDownload = () => {
    setIsProcessing(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const shifted = getShiftedMessages();

      // Reconstruct fieldDescriptions for developer fields
      const fieldDescriptions = {};
      if (messagesGrouped) {
        for (const fDesc of messagesGrouped.fieldDescriptionMesgs || []) {
          const devDataId = messagesGrouped.developerDataIdMesgs?.find(
            d => d.developerDataIndex === fDesc.developerDataIndex
          );
          if (devDataId) {
            fieldDescriptions[fDesc.key] = {
              developerDataIdMesg: devDataId,
              fieldDescriptionMesg: fDesc
            };
          }
        }
      }

      const encoder = new Encoder({ fieldDescriptions });

      for (const { mesgNum, mesg } of shifted) {
        encoder.onMesg(mesgNum, mesg);
      }

      const outputBytes = encoder.close();
      
      // Download the file in browser
      const blob = new Blob([outputBytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      
      // Append shift tag to filename
      const baseName = fileName.replace('.fit', '').replace(' (Workspace)', '');
      const dirTag = shiftDirection > 0 ? 'plus' : 'minus';
      const absHours = Math.abs(hours);
      const absMins = Math.abs(minutes);
      const absSecs = Math.abs(seconds);
      let tag = '';
      if (absHours) tag += `_${absHours}h`;
      if (absMins) tag += `_${absMins}m`;
      if (absSecs) tag += `_${absSecs}s`;
      if (ms) tag += `_${Math.abs(ms)}ms`;
      if (!tag) tag = '_shifted';
      
      link.href = url;
      link.download = `${baseName}_shifted_${dirTag}${tag}.fit`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setSuccessMsg('Modified FIT file downloaded successfully!');
    } catch (err) {
      console.error(err);
      setError(`Encoding failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatDuration = (secs) => {
    if (!secs) return '0s';
    const roundedSecs = Math.round(secs);
    const h = Math.floor(roundedSecs / 3600);
    const m = Math.floor((roundedSecs % 3600) / 60);
    const s = roundedSecs % 60;
    return [
      h > 0 ? `${h}h` : null,
      m > 0 ? `${m}m` : null,
      s > 0 ? `${s}s` : null
    ].filter(Boolean).join(' ');
  };

  const formatFullDate = (date) => {
    if (!date) return '--';
    return new Date(date).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium'
    });
  };

  // Get shifted date preview
  const getShiftedDate = (origDate) => {
    if (!origDate) return null;
    return new Date(origDate.getTime() + totalShiftMs);
  };

  // Preview first 5 records
  const recordsPreview = messagesGrouped?.recordMesgs?.slice(0, 5) || [];

  return (
    <>
      <header className="app-header">
        <div className="logo-container">
          <span className="logo-icon">⏱️</span>
          <div className="logo-text">
            <h1>FIT Time Shifter</h1>
            <p>Premium Garmin/Suunto Timestamp Adjuster</p>
          </div>
        </div>
        <div className="header-badges">
          <div className="badge">
            SDK v21.205
          </div>
          {metadata && (
            <div className="badge badge-green">
              <CheckCircle size={12} /> File Loaded
            </div>
          )}
        </div>
      </header>

      <main className="app-container">
        {/* Left Sidebar: Inputs and File Upload */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* File Upload Card */}
          <div className="card">
            <h3 className="section-title" style={{ marginBottom: '16px' }}>
              <UploadCloud size={18} style={{ color: 'var(--accent)' }} />
              FIT Source File
            </h3>
            
            <div 
              className="dropzone"
              onClick={() => document.getElementById('fit-upload-input').click()}
            >
              <input 
                type="file" 
                id="fit-upload-input" 
                accept=".fit" 
                style={{ display: 'none' }} 
                onChange={handleFileUpload}
              />
              <div className="dropzone-icon">⏱️</div>
              <div className="dropzone-text">
                <h3>{fileName ? fileName : 'Upload a FIT file'}</h3>
                <p>Drag and drop your .fit export here or click to browse</p>
              </div>
            </div>

            {!fileName && (
              <div style={{ textAlign: 'center' }}>
                <button className="quick-load-btn" onClick={loadDefaultFit} disabled={isProcessing}>
                  {isProcessing ? 'Loading...' : 'Quick Load suunto.fit (Workspace)'}
                </button>
              </div>
            )}
          </div>

          {/* Time Adjustment Card */}
          <div className="card">
            <h3 className="section-title" style={{ marginBottom: '16px' }}>
              <Clock size={18} style={{ color: 'var(--accent)' }} />
              Timestamp Shift
            </h3>

            <div className="control-section">
              <div className="form-group">
                <span className="form-label">Direction</span>
                <div className="btn-group">
                  <button 
                    className={`toggle-btn ${shiftDirection === 1 ? 'active' : ''}`}
                    onClick={() => setShiftDirection(1)}
                  >
                    Forward (+)
                  </button>
                  <button 
                    className={`toggle-btn ${shiftDirection === -1 ? 'active' : ''}`}
                    onClick={() => setShiftDirection(-1)}
                  >
                    Backward (-)
                  </button>
                </div>
              </div>

              <div className="form-group">
                <span className="form-label">Shift Duration</span>
                <div className="time-inputs-grid">
                  <div className="input-wrapper">
                    <input 
                      type="number" 
                      min="0" 
                      max="999"
                      className="number-input" 
                      value={hours}
                      onChange={(e) => setHours(Math.max(0, parseInt(e.target.value) || 0))}
                    />
                    <span className="input-unit">Hours</span>
                  </div>
                  
                  <div className="input-wrapper">
                    <input 
                      type="number" 
                      min="0" 
                      max="59"
                      className="number-input" 
                      value={minutes}
                      onChange={(e) => setMinutes(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                    />
                    <span className="input-unit">Mins</span>
                  </div>

                  <div className="input-wrapper">
                    <input 
                      type="number" 
                      min="0" 
                      max="59"
                      className="number-input" 
                      value={seconds}
                      onChange={(e) => setSeconds(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                    />
                    <span className="input-unit">Secs</span>
                  </div>
                </div>
              </div>

              <div className="form-group">
                <div className="ms-input-wrapper">
                  <span className="form-label" style={{ margin: 0 }}>Fine-tune (ms)</span>
                  <input 
                    type="number"
                    min="0"
                    max="999"
                    className="ms-input"
                    value={ms}
                    onChange={(e) => setMs(Math.max(0, Math.min(999, parseInt(e.target.value) || 0)))}
                  />
                </div>
              </div>

              {/* Reset Button */}
              {(hours > 0 || minutes > 0 || seconds > 0 || ms > 0) && (
                <button 
                  className="quick-load-btn" 
                  style={{ alignSelf: 'center', marginTop: 0 }}
                  onClick={() => {
                    setHours(0);
                    setMinutes(0);
                    setSeconds(0);
                    setMs(0);
                  }}
                >
                  Reset Settings
                </button>
              )}

              <div style={{ borderTop: '1px solid var(--border-color)', pt: '20px', marginTop: '12px' }}>
                <button 
                  className="primary-btn success-btn"
                  onClick={handleDownload}
                  disabled={!fileBuffer || isProcessing || totalShiftMs === 0}
                >
                  <Download size={18} />
                  {isProcessing ? 'Exporting...' : 'Export & Download'}
                </button>
              </div>
            </div>
          </div>

        </div>

        {/* Right Main Workspace */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          
          {/* Status / Notifications */}
          {error && (
            <div className="alert-banner alert-error">
              <AlertCircle size={18} />
              <div>{error}</div>
            </div>
          )}

          {successMsg && (
            <div className="alert-banner alert-success">
              <CheckCircle size={18} />
              <div>{successMsg}</div>
            </div>
          )}

          {/* File Summary Workspace */}
          {metadata ? (
            <>
              <div className="card">
                <h3 className="section-title" style={{ marginBottom: '20px' }}>
                  <Activity size={18} style={{ color: 'var(--success)' }} />
                  Activity Summary
                </h3>

                <div className="stats-grid" style={{ marginBottom: '24px' }}>
                  <div className="stat-card">
                    <span className="stat-label">Manufacturer</span>
                    <span className="stat-value" style={{ textTransform: 'capitalize' }}>
                      {metadata.manufacturer}
                    </span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Device</span>
                    <span className="stat-value">{metadata.productName}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Duration</span>
                    <span className="stat-value">{formatDuration(metadata.duration)}</span>
                  </div>
                  <div className="stat-card">
                    <span className="stat-label">Data Points</span>
                    <span className="stat-value">{metadata.recordCount}</span>
                  </div>
                </div>

                <div className="stats-grid" style={{ marginBottom: '24px' }}>
                  {metadata.avgHeartRate && (
                    <div className="stat-card" style={{ flexDirection: 'row', alignItems: 'center', gap: '12px' }}>
                      <div style={{ color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', padding: '10px', borderRadius: '8px' }}>
                        <Heart size={20} fill="#ef4444" />
                      </div>
                      <div>
                        <span className="stat-label">Heart Rate (Avg/Max)</span>
                        <span className="stat-value" style={{ display: 'block', fontSize: '1.05rem' }}>
                          {metadata.avgHeartRate} / {metadata.maxHeartRate} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>bpm</span>
                        </span>
                      </div>
                    </div>
                  )}
                  {metadata.avgTemp !== null && (
                    <div className="stat-card" style={{ flexDirection: 'row', alignItems: 'center', gap: '12px' }}>
                      <div style={{ color: 'var(--accent)', background: 'var(--accent-glow)', padding: '10px', borderRadius: '8px' }}>
                        ⏱️
                      </div>
                      <div>
                        <span className="stat-label">Avg Temp</span>
                        <span className="stat-value" style={{ display: 'block', fontSize: '1.05rem' }}>
                          {metadata.avgTemp} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>°C</span>
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="meta-list">
                  <div className="meta-item">
                    <span className="meta-label">File Message Types</span>
                    <span className="meta-val">{originalMessages.length} total messages</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Original Start</span>
                    <span className="meta-val">{formatFullDate(metadata.startTime)}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Original End</span>
                    <span className="meta-val">{formatFullDate(metadata.endTime)}</span>
                  </div>
                </div>
              </div>

              {/* Shift Visualization Card */}
              <div className="card">
                <h3 className="section-title" style={{ marginBottom: '20px' }}>
                  <Calendar size={18} style={{ color: 'var(--warning)' }} />
                  Time Shift Visualization
                </h3>

                <div className="time-diff-container">
                  <div className="time-node">
                    <div className="time-node-line"></div>
                    <div className="time-node-icon orig">
                      ●
                    </div>
                    <div className="time-node-info">
                      <h4>Original Timeline</h4>
                      <p>{formatFullDate(metadata.startTime)}</p>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        to {formatFullDate(metadata.endTime)}
                      </span>
                    </div>
                  </div>

                  <div className="time-arrow-divider">
                    <ArrowRight size={16} />
                    <span>Shifted by {totalShiftMs === 0 ? '0ms (No Shift)' : `${formatDuration(Math.abs(totalShiftMs)/1000)} ${shiftDirection > 0 ? 'Forward' : 'Backward'}`}</span>
                  </div>

                  <div className="time-node">
                    <div className="time-node-icon shift">
                      ★
                    </div>
                    <div className="time-node-info">
                      <h4>New Shifted Timeline</h4>
                      <p>{formatFullDate(getShiftedDate(metadata.startTime))}</p>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        to {formatFullDate(getShiftedDate(metadata.endTime))}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Preview Table Card */}
              {recordsPreview.length > 0 && (
                <div className="card">
                  <h3 className="section-title" style={{ marginBottom: '20px' }}>
                    <ChevronRight size={18} style={{ color: 'var(--accent)' }} />
                    Data Record Preview (First 5 rows)
                  </h3>
                  
                  <div className="table-container">
                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Original Timestamp</th>
                          <th>Shifted Timestamp</th>
                          <th>Heart Rate</th>
                          <th>Altitude</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recordsPreview.map((r, idx) => (
                          <tr key={idx}>
                            <td>{idx + 1}</td>
                            <td className="time-col-orig">{new Date(r.timestamp).toLocaleTimeString()}</td>
                            <td className="time-col-new">
                              {getShiftedDate(new Date(r.timestamp))?.toLocaleTimeString()}
                            </td>
                            <td>{r.heartRate ? `${r.heartRate} bpm` : '--'}</td>
                            <td>{r.altitude ? `${r.altitude} m` : '--'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="card" style={{ textAlign: 'center', padding: '80px 40px', color: 'var(--text-secondary)' }}>
              <div style={{ fontSize: '4rem', marginBottom: '24px' }}>⏱️</div>
              <h2 style={{ marginBottom: '12px', color: '#ffffff' }}>No FIT File Loaded</h2>
              <p style={{ maxWidth: '480px', margin: '0 auto' }}>
                Please load the default FIT file using the button on the left, or upload any standard Garmin / Suunto FIT activity file to adjust its timestamps.
              </p>
            </div>
          )}

        </div>
      </main>

      <footer className="app-footer">
        <p>FIT Time Shifter • Pure Client-Side • No Files are Sent to Server</p>
        <p style={{ marginTop: '8px', fontSize: '0.8rem' }}>
          Powered by the official Garmin FIT SDK &bull; Antigravity premium design
        </p>
      </footer>
    </>
  );
}

export default App;
