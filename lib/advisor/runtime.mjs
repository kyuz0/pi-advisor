// Nested containers cannot always mount fresh proc/devpts filesystems.
// Expose only the four basic pseudo-devices; no process filesystem or host devices.
export function runtimeMounts(container) {
  if (!container) return ['--proc', '/proc', '--dev', '/dev'];
  return ['--dir', '/proc', '--dir', '/dev', ...['null','zero','random','urandom'].flatMap(name => ['--dev-bind', '/dev/' + name, '/dev/' + name])];
}
