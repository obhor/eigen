/**
 * Eraser Engine
 * Hit-tests stored paths against the eraser circle; repaint is the caller's job.
 */
export class EraserEngine {
  constructor() {
    this.eraserRadius = 20; // Default eraser size
  }

  /**
   * Set eraser size
   */
  setRadius(radius) {
    this.eraserRadius = radius;
  }

  /**
   * Get eraser radius
   */
  getRadius() {
    return this.eraserRadius;
  }

  /**
   * Split paths into surviving/erased by eraser intersection.
   */
  erasePaths(paths, x, y) {
    const survivingPaths = [];
    const erasedPaths = [];
    
    paths.forEach(path => {
      if (!this.pathIntersectsEraser(path, x, y)) {
        // Path doesn't intersect, keep it
        survivingPaths.push(path);
      } else {
        // Path intersects, mark as erased
        erasedPaths.push(path);
      }
    });
    
    return { survivingPaths, erasedPaths };
  }

  /**
   * Check if a path intersects with the eraser circle
   */
  pathIntersectsEraser(pathData, eraserX, eraserY) {
    if (!pathData.points || pathData.points.length === 0) return false;
    
    const radiusSquared = this.eraserRadius * this.eraserRadius;
    
    // Check if any point in the path is within eraser radius
    for (const point of pathData.points) {
      const dx = point.x - eraserX;
      const dy = point.y - eraserY;
      const distSquared = dx * dx + dy * dy;
      
      if (distSquared <= radiusSquared) {
        return true;
      }
    }
    
    // Also check line segments (in case eraser is between points)
    for (let i = 0; i < pathData.points.length - 1; i++) {
      const p1 = pathData.points[i];
      const p2 = pathData.points[i + 1];
      
      if (this.lineSegmentIntersectsCircle(p1.x, p1.y, p2.x, p2.y, eraserX, eraserY, this.eraserRadius)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if a line segment intersects with a circle
   */
  lineSegmentIntersectsCircle(x1, y1, x2, y2, cx, cy, radius) {
    // Vector from line start to circle center
    const dx = cx - x1;
    const dy = cy - y1;
    
    // Vector of the line segment
    const lx = x2 - x1;
    const ly = y2 - y1;
    
    // Length squared of line segment
    const lenSq = lx * lx + ly * ly;
    
    if (lenSq === 0) {
      // Line segment is a point
      const distSq = dx * dx + dy * dy;
      return distSq <= radius * radius;
    }
    
    // Parameter t of closest point on line segment
    let t = (dx * lx + dy * ly) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    // Closest point on line segment
    const closestX = x1 + t * lx;
    const closestY = y1 + t * ly;
    
    // Distance from circle center to closest point
    const distX = cx - closestX;
    const distY = cy - closestY;
    const distSq = distX * distX + distY * distY;
    
    return distSq <= radius * radius;
  }

  /**
   * Draw eraser cursor on canvas (for preview)
   */
  drawCursor(canvas, x, y) {
    const ctx = canvas.getContext('2d');
    
    ctx.save();
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(x, y, this.eraserRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
