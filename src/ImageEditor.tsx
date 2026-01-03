import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import "./ImageEditor.css";

interface ImageEditorProps {
  imageData: string; // Base64
}

export interface ImageEditorRef {
  getMergedImage: () => Promise<string>;
}

const ImageEditor = forwardRef<ImageEditorRef, ImageEditorProps>(({ imageData }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState("#ff0000");
  const [opacity, setOpacity] = useState(1);
  const [lineWidth, setLineWidth] = useState(5);
  
  // Image dimensions for setting canvas size
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    // Load image to get dimensions
    const img = new Image();
    img.onload = () => {
      setDimensions({ width: img.width, height: img.height });
    };
    img.src = `data:image/png;base64,${imageData}`;
  }, [imageData]);

  useEffect(() => {
    // Initialize canvas context settings when tool/color/etc changes
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    
    // We update these live during drawing usually, but setting defaults here is good
  }, [tool, color, opacity, lineWidth]);

  useImperativeHandle(ref, () => ({
    getMergedImage: async () => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const exportCanvas = document.createElement("canvas");
          exportCanvas.width = dimensions.width;
          exportCanvas.height = dimensions.height;
          const ctx = exportCanvas.getContext("2d");
          if (ctx) {
             // 1. Draw Image
             ctx.drawImage(img, 0, 0);
             // 2. Draw Annotations
             if (canvasRef.current) {
                 ctx.drawImage(canvasRef.current, 0, 0);
             }
             // 3. Export
             resolve(exportCanvas.toDataURL("image/png").split(",")[1]);
          }
        };
        img.src = `data:image/png;base64,${imageData}`;
      });
    }
  }));

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setIsDrawing(true);
    const { x, y } = getCoordinates(e, canvas);
    
    ctx.beginPath();
    ctx.moveTo(x, y);
    
    // Set styles for this stroke
    ctx.lineWidth = lineWidth;
    if (tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)"; // Color doesn't matter for destination-out
    } else {
        ctx.globalCompositeOperation = "source-over";
        // Convert hex color to rgba for opacity
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { x, y } = getCoordinates(e, canvas);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.closePath();
    }
  };

  const getCoordinates = (e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) => {
      // Handle Touch and Mouse uniformly
      let clientX, clientY;
      if ('touches' in e) {
          clientX = e.touches[0].clientX;
          clientY = e.touches[0].clientY;
      } else {
          clientX = (e as React.MouseEvent).clientX;
          clientY = (e as React.MouseEvent).clientY;
      }

      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
          x: (clientX - rect.left) * scaleX,
          y: (clientY - rect.top) * scaleY
      };
  };

  const clearCanvas = () => {
      const canvas = canvasRef.current;
      if (canvas) {
          const ctx = canvas.getContext("2d");
          ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
  };

  return (
    <div className="image-editor-container">
      <div className="editor-toolbar">
         <div className="tool-group">
             <button 
                className={tool === "pen" ? "active" : ""} 
                onClick={() => setTool("pen")}>
                ✏️ Pen
             </button>
             <button 
                className={tool === "eraser" ? "active" : ""} 
                onClick={() => setTool("eraser")}>
                🧹 Eraser
             </button>
             <button onClick={clearCanvas} title="Clear All Drawings">
                🗑️ Clear All
             </button>
         </div>
         
         {tool === "pen" && (
             <div className="tool-settings">
                 <input 
                    type="color" 
                    value={color} 
                    onChange={(e) => setColor(e.target.value)} 
                    title="Color"
                 />
                 <div className="slider-group">
                    <label>Opacity</label>
                    <input 
                        type="range" 
                        min="0.1" 
                        max="1" 
                        step="0.1" 
                        value={opacity} 
                        onChange={(e) => setOpacity(parseFloat(e.target.value))} 
                    />
                 </div>
             </div>
         )}
         
         <div className="slider-group">
            <label>Size</label>
            <input 
                type="range" 
                min="1" 
                max="50" 
                value={lineWidth} 
                onChange={(e) => setLineWidth(parseInt(e.target.value))} 
            />
         </div>
      </div>

      <div className="canvas-wrapper" ref={containerRef}>
        <img 
            src={`data:image/png;base64,${imageData}`} 
            alt="Base" 
            style={{ display: "block", maxWidth: "100%" }} 
        />
        <canvas
            ref={canvasRef}
            width={dimensions.width}
            height={dimensions.height}
            className="annotation-canvas"
            onMouseDown={startDrawing}
            onMouseMove={draw}
            onMouseUp={stopDrawing}
            onMouseLeave={stopDrawing}
            onTouchStart={startDrawing}
            onTouchMove={draw}
            onTouchEnd={stopDrawing}
        />
      </div>
    </div>
  );
});

export default ImageEditor;
