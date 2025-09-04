#!/usr/bin/env node
/**
 * Performance Monitor for Gateway
 * Tracks memory, CPU, and connection metrics
 */

import { spawn } from 'child_process';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      memory: { heapUsed: 0, heapTotal: 0, external: 0, rss: 0 },
      cpu: { user: 0, system: 0 },
      connections: { http: 0, https: 0, websocket: 0 },
      eventLoop: { lag: 0, utilization: 0 },
      processes: []
    };
    this.startTime = Date.now();
    this.lastCpuUsage = process.cpuUsage();
    this.eventLoopLag = 0;
  }

  async gatherMetrics() {
    try {
      // Memory metrics
      const memUsage = process.memoryUsage();
      this.metrics.memory = {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100, // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
        external: Math.round(memUsage.external / 1024 / 1024 * 100) / 100,
        rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100
      };

      // CPU metrics
      const cpuUsage = process.cpuUsage(this.lastCpuUsage);
      this.metrics.cpu = {
        user: Math.round(cpuUsage.user / 1000), // Convert to ms
        system: Math.round(cpuUsage.system / 1000)
      };
      this.lastCpuUsage = process.cpuUsage();

      // Event loop lag
      this.measureEventLoopLag();

      // Node.js processes count
      try {
        const result = await this.getNodeProcesses();
        this.metrics.processes = result;
      } catch (e) {
        this.metrics.processes = [{ name: 'node.exe', pid: process.pid, memory: `${Math.round(process.memoryUsage().rss / 1024)} K` }];
        console.error('Note: Could not get full process list:', e.message);
      }

      return this.metrics;
    } catch (error) {
      console.error('Error gathering metrics:', error);
      return this.metrics;
    }
  }

  measureEventLoopLag() {
    const start = performance.now();
    setImmediate(() => {
      this.eventLoopLag = Math.round(performance.now() - start);
      this.metrics.eventLoop.lag = this.eventLoopLag;
    });
  }

  getNodeProcesses() {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      
      if (isWindows) {
        // Use simplified command for better compatibility
        const proc = spawn('tasklist', ['/FI', 'IMAGENAME eq node.exe'], { shell: false });
        
        let output = '';
        let errorOutput = '';
        
        proc.stdout.on('data', (data) => output += data);
        proc.stderr.on('data', (data) => errorOutput += data);
        
        proc.on('close', (code) => {
          try {
            if (code !== 0) {
              return reject(new Error(`Process command failed with code ${code}: ${errorOutput}`));
            }
            
            const lines = output.split('\n').filter(l => l.trim() && l.includes('node.exe'));
            const processes = lines.map(line => {
              // Parse the fixed-width format
              const match = line.match(/node\.exe\s+(\d+)\s+\w+\s+\d+\s+([\d,]+\s+K)/);
              if (match) {
                return {
                  name: 'node.exe',
                  pid: match[1],
                  memory: match[2]
                };
              }
              return null;
            }).filter(p => p !== null);
            
            resolve(processes);
          } catch (e) {
            reject(new Error(`Failed to parse process output: ${e.message}`));
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`Failed to spawn tasklist: ${err.message}`));
        });
      } else {
        // Linux/Mac version
        const proc = spawn('ps', ['-eo', 'pid,ppid,cmd,rss'], { shell: false });
        let output = '';
        
        proc.stdout.on('data', (data) => output += data);
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error('ps command failed'));
          
          const lines = output.split('\n').filter(l => l.includes('node'));
          const processes = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            return {
              name: 'node',
              pid: parts[0],
              memory: `${parts[3]} K`
            };
          });
          resolve(processes);
        });
      }
    });
  }

  formatMetrics() {
    const uptime = Math.round((Date.now() - this.startTime) / 1000);
    const processCount = this.metrics.processes.length;
    const totalMemory = this.metrics.processes.reduce((sum, p) => {
      const memStr = p.memory.replace(/[^\d]/g, '');
      return sum + (parseInt(memStr) || 0);
    }, 0);

    return `
┌─ Gateway Performance Monitor ─────────────────────────┐
│ Uptime: ${uptime}s | Processes: ${processCount} | Total RAM: ${Math.round(totalMemory/1024)}MB      │
├─ Current Process Memory (MB) ─────────────────────────┤
│ Heap Used:  ${this.metrics.memory.heapUsed.toString().padStart(8)} │ RSS: ${this.metrics.memory.rss.toString().padStart(8)} │
│ Heap Total: ${this.metrics.memory.heapTotal.toString().padStart(8)} │ Ext: ${this.metrics.memory.external.toString().padStart(8)} │
├─ CPU Usage (ms since last check) ────────────────────┤
│ User: ${this.metrics.cpu.user.toString().padStart(6)} │ System: ${this.metrics.cpu.system.toString().padStart(6)}       │
├─ Event Loop ──────────────────────────────────────────┤
│ Lag: ${this.eventLoopLag.toString().padStart(4)}ms                                │
├─ All Node.js Processes ───────────────────────────────┤
${this.metrics.processes.length > 0 
  ? this.metrics.processes.slice(0, 8).map(p => `│ PID ${p.pid}: ${p.memory.padStart(10)}                    │`).join('\n')
  : '│ No detailed process info available            │'
}${this.metrics.processes.length > 8 ? `\n│ ... and ${this.metrics.processes.length - 8} more processes           │` : ''}
└───────────────────────────────────────────────────────┘`;
  }

  async startMonitoring(intervalMs = 5000) {
    console.log('🚀 Starting Gateway Performance Monitor...');
    console.log(`📊 Monitoring every ${intervalMs/1000} seconds`);
    console.log('Press Ctrl+C to stop\n');
    
    const monitor = async () => {
      try {
        await this.gatherMetrics();
        console.clear();
        console.log(this.formatMetrics());
        
        // Performance alerts
        const warnings = [];
        if (this.metrics.memory.heapUsed > 100) {
          warnings.push('⚠️  HIGH MEMORY USAGE: Heap exceeds 100MB');
        }
        if (this.eventLoopLag > 10) {
          warnings.push('⚠️  EVENT LOOP LAG: >10ms delay detected');
        }
        if (this.metrics.processes.length > 8) {
          warnings.push('⚠️  HIGH PROCESS COUNT: Many Node.js processes running');
        }
        
        if (warnings.length > 0) {
          console.log('\n' + warnings.join('\n'));
        }
        
        console.log(`\n📈 Next update in ${intervalMs/1000}s...`);
      } catch (error) {
        console.error('Monitoring error:', error);
      }
    };

    // Initial run
    await monitor();
    
    const interval = setInterval(monitor, intervalMs);
    
    process.on('SIGINT', () => {
      clearInterval(interval);
      console.log('\n\n👋 Performance monitoring stopped');
      process.exit(0);
    });

    // Prevent process from exiting
    process.stdin.resume();
  }
}

// CLI usage
const isMainModule = process.argv[1] && process.argv[1].includes('performance-monitor.js');

if (isMainModule) {
  const monitor = new PerformanceMonitor();
  const interval = parseInt(process.argv[2]) || 5000;
  
  console.log('Starting performance monitor...');
  monitor.startMonitoring(interval).catch(err => {
    console.error('Monitor failed to start:', err);
    process.exit(1);
  });
}

export default PerformanceMonitor;
