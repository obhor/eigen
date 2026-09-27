/**
 * Drawing Engine
 * Handles drawing on the overlay canvas using DrawToolState
 */
export class DrawingEngine {
  constructor(drawToolState) {
    this.state = drawToolState;
    this.isDrawing = false;
    this.currentPath = null;
    this.overlayCanvas = null;
    this.ctx = null;
  }

  /**
   * Initialize drawing on a specific canvas
   */
  initCanvas(overlayCanvas) {
    this.overlayCanvas = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');
  }

  /**
   * Start drawing
   */
  startDrawing(x, y) {
    if (!this.state.isEnabled() || !this.ctx) {
      console.log('Cannot start drawing:', { 
        enabled: this.state.isEnabled(), 
        hasCtx: !!this.ctx 
      });
      return;
    }
    
    this.isDrawing = true;
    this.currentPath = [{ x, y }];
    
    // Setup canvas context with current state
    const color = this.state.getColor();
    const thickness = this.state.getThickness();
    
    console.log('Starting path with:', { color, thickness, x, y });
    
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = thickness;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
  }

  /**
   * Continue drawing (mouse move)
   */
  continueDrawing(x, y) {
    if (!this.isDrawing || !this.ctx) return;
    
    this.currentPath.push({ x, y });
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    
    // Debug: draw a visible dot
    if (this.currentPath.length % 5 === 0) {
      console.log('Drawing point:', x, y, 'Total points:', this.currentPath.length);
    }
  }

  /**
   * Stop drawing
   */
  stopDrawing() {
    if (!this.isDrawing) return;
    
    this.isDrawing = false;
    
    // Return path data for saving
    const pathData = {
      points: this.currentPath,
      color: this.state.getColor(),
      thickness: this.state.getThickness(),
      timestamp: Date.now()
    };
    
    this.currentPath = null;
    return pathData;
  }

  /**
   * Clear canvas
   */
  clear() {
    if (!this.ctx || !this.overlayCanvas) return;
    this.ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  /**
   * Redraw a saved path
   */
  drawPath(pathData) {
    if (!this.ctx || !pathData.points || pathData.points.length === 0) return;
    
    this.ctx.strokeStyle = pathData.color;
    this.ctx.lineWidth = pathData.thickness;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    
    // If color is rgba with low alpha, it's a highlight - use lighten mode to prevent overlap darkening
    if (pathData.color && pathData.color.startsWith('rgba')) {
      this.ctx.globalCompositeOperation = 'lighten';
    } else {
      this.ctx.globalCompositeOperation = 'source-over';
    }
    
    this.ctx.beginPath();
    this.ctx.moveTo(pathData.points[0].x, pathData.points[0].y);
    
    for (let i = 1; i < pathData.points.length; i++) {
      this.ctx.lineTo(pathData.points[i].x, pathData.points[i].y);
    }
    
    this.ctx.stroke();
    
    // Reset to default
    this.ctx.globalCompositeOperation = 'source-over';
  }
}
