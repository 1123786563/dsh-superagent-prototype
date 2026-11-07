const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/

function objectConfig(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
}

function booleanConfig(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function clockConfig(value, name, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a valid HH:mm time (00:00–23:59)`)
  }
  return value
}

function clockFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    numberingSystem: 'latn',
  })
}

/** Validate without mutation and return the execution settings with defaults filled in. */
export function validateExecutionConfig(config = {}) {
  objectConfig(config, 'config')
  const enabled = booleanConfig(config.enabled, 'enabled', true)
  const window = config.executionWindow === undefined ? {} : config.executionWindow
  objectConfig(window, 'executionWindow')
  const windowEnabled = booleanConfig(window.enabled, 'executionWindow.enabled', false)
  const start = clockConfig(window.start, 'executionWindow.start', '09:00')
  const end = clockConfig(window.end, 'executionWindow.end', '22:00')
  const timeZone = window.timeZone === undefined ? 'Asia/Shanghai' : window.timeZone
  if (typeof timeZone !== 'string' || !timeZone || /^[+-]/.test(timeZone)) {
    throw new TypeError('executionWindow.timeZone must be a valid IANA time zone')
  }
  try {
    clockFormatter(timeZone)
  } catch {
    throw new RangeError('executionWindow.timeZone must be a valid IANA time zone')
  }
  if (windowEnabled && start === end) {
    throw new RangeError('executionWindow.start and end must differ; disable the window for full-day execution')
  }
  return { enabled, executionWindow: { enabled: windowEnabled, timeZone, start, end } }
}

/** Daily local-clock permission; start is inclusive and end is exclusive, including overnight. */
export function executionState(config, now = new Date()) {
  const { enabled, executionWindow: window } = validateExecutionConfig(config)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date')
  }
  const { timeZone, start, end } = window
  const parts = clockFormatter(timeZone).formatToParts(now)
  const hour = parts.find(part => part.type === 'hour').value
  const minute = parts.find(part => part.type === 'minute').value
  const localTime = `${hour}:${minute}`
  const inWindow = start < end
    ? localTime >= start && localTime < end
    : localTime >= start || localTime < end
  const reason = !enabled ? 'disabled'
    : window.enabled && !inWindow ? 'outside_window' : 'allowed'
  return { allowed: reason === 'allowed', reason, timeZone, localTime,
    windowEnabled: window.enabled, start, end }
}
