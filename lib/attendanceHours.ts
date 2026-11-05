export const isAttendanceBusinessHours = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Damascus',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(values.weekday)
    && minuteOfDay >= 8 * 60
    && minuteOfDay < 14 * 60;
};

export const isDegreeFourSupervisor = (value: unknown) => {
  const degree = String(value ?? '')
    .trim()
    .replace(/\s+/g, '')
    .toLocaleLowerCase()
    .replace(/الدرجة|درجة|درجه/g, '')
    .replace(/[\-_]/g, '');
  return ['4', '٤', 'four', 'fourth', '4th', '4thdegree', 'degree4', 'level4', 'supervisor4', 'رابعة', 'الرابعة']
    .includes(degree)
    || degree.includes('رابعة')
    || /(?:^|\D)4(?:\D|$)/.test(degree);
};
