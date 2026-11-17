import { normalizeStudentIdentifier } from './studentData';

const normalizeEmail = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase();
const normalizePhone = (value: unknown) => String(value ?? '')
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
  .replace(/\D/g, '')
  .replace(/^0+/, '');

export const isFirstLoginContactMatch = (contact: unknown, email: unknown, phone: unknown) => {
  const value = String(contact ?? '').trim();
  if (!value) return false;
  if (value.includes('@')) return normalizeEmail(value) === normalizeEmail(email);
  if (!/^[\d٠-٩+\s()-]+$/.test(value)) return false;

  const normalizedPhone = normalizePhone(value);
  return normalizedPhone !== '' && normalizedPhone === normalizePhone(phone);
};

export const normalizeFirstLoginStudentId = (value: unknown) => normalizeStudentIdentifier(value);
