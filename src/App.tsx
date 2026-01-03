import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import ReactCrop, { Crop, PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import "./App.css";

interface WindowInfo {
  id: number;
  title: string;
  app_name: string;
  width: number;
  height: number;
}

interface MonitorInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
}

type Mode = "fullscreen" | "window" | "area" | "record";

function App() {
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<Mode>("fullscreen");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null);
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null);
  
  // Area selection state
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const imgRef = useRef<HTMLImageElement>(null);
  const [originalImage, setOriginalImage] = useState<string | null>(null); // Store full screenshot for cropping

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(false);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (mode === "window") {
      fetchWindows();
    } else {
      fetchMonitors();
    }
  }, [mode]);

  useEffect(() => {
    const savedPath = localStorage.getItem("defaultPath");
    if (savedPath) {
      setDefaultPath(savedPath);
    }
    const savedAutoSave = localStorage.getItem("autoSave");
    if (savedAutoSave) {
      setAutoSave(savedAutoSave === "true");
    }
  }, []);

  async function fetchWindows() {
    try {
      const wins = await invoke<WindowInfo[]>("get_windows");
      setWindows(wins);
      if (wins.length > 0 && !selectedWindowId) {
        setSelectedWindowId(wins[0].id);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error fetching windows: ${error}`);
    }
  }

  async function fetchMonitors() {
    try {
      const mons = await invoke<MonitorInfo[]>("get_monitors");
      setMonitors(mons);
      if (mons.length > 0 && !selectedMonitorId) {
        // Find primary or select first
        const primary = mons.find(m => m.is_primary);
        setSelectedMonitorId(primary ? primary.id : mons[0].id);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error fetching monitors: ${error}`);
    }
  }

  async function capture() {
    setLoading(true);
    setStatus("Capturing...");
    try {
      let result: string;
      if (mode === "window" && selectedWindowId) {
        result = await invoke<string>("capture_window", { id: selectedWindowId });
        setImage(result);
        setOriginalImage(null);
      } else {
        // Fullscreen or Area
        // Pass selectedMonitorId if available
        result = await invoke<string>("capture_screen", { monitorId: selectedMonitorId });
        if (mode === "area") {
          setOriginalImage(result);
          setImage(null);
          setStatus("Select area to crop");
        } else {
          setImage(result);
          setOriginalImage(null);
        }
      }
      
      if (mode !== "area") {
        setStatus("Captured!");
        if (autoSave) {
           // Small delay to ensure state update? Not needed for direct call but good practice
           setTimeout(() => saveImage(result), 100);
        }
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${error}`);
    } finally {
      setLoading(false);
    }
  }

  async function confirmCrop() {
    if (completedCrop && imgRef.current && originalImage) {
      const canvas = document.createElement("canvas");
      // Use natural dimensions for high DPI correctness
      const scaleX = imgRef.current.naturalWidth / imgRef.current.width;
      const scaleY = imgRef.current.naturalHeight / imgRef.current.height;
      
      canvas.width = completedCrop.width * scaleX;
      canvas.height = completedCrop.height * scaleY;
      
      const ctx = canvas.getContext("2d");

      if (ctx) {
        // Improve scaling quality
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        ctx.drawImage(
          imgRef.current,
          completedCrop.x * scaleX,
          completedCrop.y * scaleY,
          completedCrop.width * scaleX,
          completedCrop.height * scaleY,
          0,
          0,
          canvas.width,
          canvas.height
        );
        const base64 = canvas.toDataURL("image/png").split(",")[1];
        setImage(base64);
        setOriginalImage(null);
        setStatus("Cropped!");
        
        if (autoSave) {
            saveImage(base64);
        }
      }
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
      mediaRecorderRef.current = mediaRecorder;
      recordedChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        
        // Save video
        saveVideo(Array.from(bytes));
        
        // Stop all tracks to release screen
        stream.getTracks().forEach(track => track.stop());
        setIsRecording(false);
        setStatus("Recording finished and saved.");
      };

      mediaRecorder.start();
      setIsRecording(true);
      setStatus("Recording...");
    } catch (err) {
      console.error("Error starting recording:", err);
      setStatus(`Recording Error: ${err}`);
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
  }

  async function saveVideo(bytes: number[]) {
    try {
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `recording_${timestamp}.webm`;
      
      let path: string | null = null;

      if (autoSave && defaultPath) {
        path = `${defaultPath}/${filename}`;
      } else {
        path = await save({
            defaultPath: defaultPath ? `${defaultPath}/${filename}` : filename,
            filters: [{ name: "Video", extensions: ["webm"] }],
        });
      }

      if (path) {
        await invoke("save_video", { path, data: bytes });
        setStatus(`Video saved to ${path}`);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Save Video Error: ${error}`);
    }
  }

  async function selectDefaultFolder() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      if (selected && typeof selected === "string") {
        setDefaultPath(selected);
        localStorage.setItem("defaultPath", selected);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Error selecting folder: ${error}`);
    }
  }

  function toggleAutoSave() {
      const newValue = !autoSave;
      setAutoSave(newValue);
      localStorage.setItem("autoSave", String(newValue));
  }

  async function saveImage(imgData?: string) {
    const dataToSave = imgData || image;
    if (!dataToSave) return;
    
    try {
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `screenshot_${mode}_${timestamp}.png`;

      let path: string | null = null;

      if (autoSave && defaultPath) {
          path = `${defaultPath}/${filename}`;
      } else {
          path = await save({
            defaultPath: defaultPath ? `${defaultPath}/${filename}` : filename,
            filters: [
              {
                name: "Image",
                extensions: ["png"],
              },
            ],
          });
      }
      
      if (path) {
        await invoke("save_image", { path, data: dataToSave });
        setStatus(`Saved to ${path}`);
      }
    } catch (error) {
      console.error(error);
      setStatus(`Save Error: ${error}`);
    }
  }

  return (
    <main className="container">
      <div className="header">
        <h1>Screenshot App</h1>
        <button 
          className="settings-toggle" 
          onClick={() => setShowSettings(!showSettings)}
        >
          ⚙️
        </button>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <h3>Settings</h3>
          <div className="setting-item">
            <label>Default Save Folder:</label>
            <div className="path-display">
              {defaultPath || "Not set (User Home)"}
            </div>
            <button onClick={selectDefaultFolder}>Change Folder</button>
          </div>
          <div className="setting-item checkbox">
              <label>
                  <input type="checkbox" checked={autoSave} onChange={toggleAutoSave} />
                  Auto Save (Skip Dialog)
              </label>
          </div>
        </div>
      )}

      <div className="controls">
        <div className="mode-selector">
          <label>
            <input
              type="radio"
              value="fullscreen"
              checked={mode === "fullscreen"}
              onChange={() => setMode("fullscreen")}
            />
            Full Screen
          </label>
          <label>
            <input
              type="radio"
              value="window"
              checked={mode === "window"}
              onChange={() => setMode("window")}
            />
            Window
          </label>
          <label>
            <input
              type="radio"
              value="area"
              checked={mode === "area"}
              onChange={() => setMode("area")}
            />
            Area
          </label>
          <label>
            <input
              type="radio"
              value="record"
              checked={mode === "record"}
              onChange={() => setMode("record")}
            />
            Record
          </label>
        </div>

        {mode === "window" && (
          <div className="window-selector">
            <select
              value={selectedWindowId || ""}
              onChange={(e) => setSelectedWindowId(Number(e.target.value))}
            >
              {windows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.app_name || "Unknown"} - {w.title.substring(0, 30)} ({w.width}x{w.height})
                </option>
              ))}
            </select>
            <button onClick={fetchWindows}>↻</button>
          </div>
        )}

        {(mode === "fullscreen" || mode === "area") && monitors.length > 1 && (
           <div className="monitor-selector">
             <label>Monitor: </label>
             <select
               value={selectedMonitorId || ""}
               onChange={(e) => setSelectedMonitorId(Number(e.target.value))}
             >
               {monitors.map((m) => (
                 <option key={m.id} value={m.id}>
                   {m.name} ({m.width}x{m.height}) {m.is_primary ? "(Primary)" : ""}
                 </option>
               ))}
             </select>
             <button onClick={fetchMonitors}>↻</button>
           </div>
        )}

        <div className="row">
          {mode === "record" ? (
             !isRecording ? (
                <button onClick={startRecording} className="record-btn">Start Recording</button>
             ) : (
                <button onClick={stopRecording} className="stop-btn">Stop Recording</button>
             )
          ) : (
            <>
              <button onClick={capture} disabled={loading}>
                {loading ? "Capturing..." : "Capture"}
              </button>
              {image && (
                <button onClick={() => saveImage()} disabled={loading}>
                  Save Image
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <p>{status}</p>

      {originalImage && mode === "area" && (
        <div className="crop-container">
          <ReactCrop crop={crop} onChange={(c) => setCrop(c)} onComplete={(c) => setCompletedCrop(c)}>
            <img ref={imgRef} src={`data:image/png;base64,${originalImage}`} alt="Crop source" />
          </ReactCrop>
          <button onClick={confirmCrop} className="confirm-crop">Confirm Crop</button>
        </div>
      )}

      {image && mode !== "record" && (
        <div className="preview">
          <img src={`data:image/png;base64,${image}`} alt="Screenshot" />
        </div>
      )}
    </main>
  );
}

export default App;
