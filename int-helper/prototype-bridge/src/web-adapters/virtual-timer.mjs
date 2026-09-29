import { text, visible, pageUrl, singleQueryValue } from './content-helpers.mjs';

// Virtual's public Exam component renders div("เวลาสอบ") + p(HH:MM:SS).
// Only examtype=F counts down; other exam types count UP in the same card.
export const readVirtualTimer = (document, location) => {
  if (String(singleQueryValue(pageUrl(location).searchParams, 'examtype')).toUpperCase() !== 'F') {
    return { available: false, reason: 'not_final_countdown' };
  }
  const labels = [...document.querySelectorAll('div')].filter(el => visible(el) && text(el) === 'เวลาสอบ');
  const timers = labels.map(el => el.nextElementSibling).filter(el => el?.tagName === 'P' && visible(el));
  if (timers.length !== 1) return { available: false, reason: 'timer_missing_or_ambiguous' };
  const display = text(timers[0]);
  if (!/^\d{2}:[0-5]\d:[0-5]\d$/u.test(display)) return { available: false, reason: 'timer_unreadable' };
  const remainingSeconds = display.split(':').reduce((value, part) => value * 60 + Number(part), 0);
  // The website may show more than two hours at entry. Its rendered HH:MM:SS
  // is the authority; do not clamp it or infer a fixed starting count.
  return { available: true, remainingSeconds, display, source: 'virtual_school_display' };
};
