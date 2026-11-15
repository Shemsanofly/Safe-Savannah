import type { Detection } from '../domain/types.js';
import type { Frame } from './frameSource.js';

export interface Detector {
  /** Short identifier stored with each event, e.g. "yolo11n@399c995c". */
  readonly modelId: string;
  /** 'inference' for a real model; 'simulated' for the scripted stand-in. */
  readonly source: 'inference' | 'simulated';
  detect(frame: Frame): Promise<Detection[]>;
  close?(): Promise<void>;
}
