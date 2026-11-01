/**
 * Every monitor the app knows about, in dashboard order.
 * To add one: create src/monitors/<name>.js extending Monitor (see base.js),
 * import it here, and add a `<name>: { enabled: true, ... }` block to config.
 */
import VmixMonitor from './vmix.js';
import YouTubeMonitor from './youtube.js';
import AudioMonitor from './audio.js';
import ScorebotMonitor from './scorebot.js';
import OseMonitor from './ose.js';
import NdiMonitor from './ndi.js';

export const MONITORS = [VmixMonitor, YouTubeMonitor, AudioMonitor, ScorebotMonitor, OseMonitor, NdiMonitor];
