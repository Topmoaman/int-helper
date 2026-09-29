import { text, visible } from './content-helpers.mjs';

// Observed INT markup: .timer with .jst-hours/.jst-minutes/.jst-seconds.
// Read rendered digits only; data-minutes-left is the initial limit, not time left.
export const readIntTimer = document => {
  const timers = [...document.querySelectorAll('.timer')].filter(visible);
  if (timers.length !== 1) return { available: false, reason: 'timer_missing_or_ambiguous' };
  const values = ['.jst-hours', '.jst-minutes', '.jst-seconds'].map(selector => text(timers[0].querySelector(selector)).replace(/:\s*$/u, '').trim());
  if (!values.every(value => /^\d{2}$/u.test(value))) return { available: false, reason: 'timer_unreadable' };
  const [h, m, s] = values.map(Number);
  if (m > 59 || s > 59 || h * 3600 + m * 60 + s > 7200) return { available: false, reason: 'timer_invalid' };
  return { available: true, remainingSeconds: h * 3600 + m * 60 + s, display: values.join(':'), source: 'int_project_display' };
};
