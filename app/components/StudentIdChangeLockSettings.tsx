'use client';

import { useEffect, useState } from 'react';

type StudentYear = 'أولى' | 'ثانية';
type Locks = Record<StudentYear, boolean>;

const years: StudentYear[] = ['أولى', 'ثانية'];

export default function StudentIdChangeLockSettings({
  supervisorUsername,
  supervisorPassword,
}: {
  supervisorUsername: string;
  supervisorPassword: string;
}) {
  const [locks, setLocks] = useState<Locks>({ 'أولى': true, 'ثانية': true });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [savingYear, setSavingYear] = useState<StudentYear | null>(null);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoading(true);
    void fetch('/api/supervisor/student-id-change-locks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'load', username: supervisorUsername, password: supervisorPassword }),
    }).then(async (response) => {
      const result = await response.json() as { success?: boolean; locks?: Locks; message?: string };
      if (!response.ok || !result.success || !result.locks) {
        throw new Error(result.message ?? 'تعذر تحميل إعدادات تغيير الرقم الجامعي.');
      }
      if (active) {
        setLocks(result.locks);
        setLoaded(true);
      }
    }).catch((error: unknown) => {
      if (active) setNotice({ message: error instanceof Error ? error.message : 'تعذر تحميل إعدادات تغيير الرقم الجامعي.', error: true });
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [supervisorUsername, supervisorPassword]);

  const save = async (studentYear: StudentYear) => {
    setSavingYear(studentYear);
    setNotice(null);
    try {
      const isOpen = !locks[studentYear];
      const response = await fetch('/api/supervisor/student-id-change-locks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', username: supervisorUsername, password: supervisorPassword, studentYear, isOpen }),
      });
      const result = await response.json() as { success?: boolean; message?: string };
      if (!response.ok || !result.success) throw new Error(result.message ?? 'تعذر حفظ إعداد تغيير الرقم الجامعي.');
      setLocks((current) => ({ ...current, [studentYear]: isOpen }));
      setNotice({ message: `تم ${isOpen ? 'فتح' : 'إغلاق'} تغيير الرقم الجامعي للسنة ${studentYear}.`, error: false });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر حفظ إعداد تغيير الرقم الجامعي.', error: true });
    } finally {
      setSavingYear(null);
    }
  };

  return (
    <div className="student-id-change-locks" style={{ margin: '0 0 20px', padding: 18, border: '1px solid #dbe3ee', borderRadius: 12, background: '#f8fafc' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>السماح بتغيير الرقم الجامعي</h2>
      <p style={{ margin: '0 0 14px', color: '#64748b', fontSize: 13 }}>يمكن فتح أو إغلاق طلب تغيير الرقم لكل سنة بشكل مستقل.</p>
      {years.map((studentYear) => (
        <div key={studentYear} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0' }}>
          <strong>السنة {studentYear}: {loading ? 'جارٍ التحميل...' : locks[studentYear] ? 'مفتوح' : 'مغلق'}</strong>
          <button
            type="button"
            className="action-button"
            onClick={() => void save(studentYear)}
            disabled={loading || !loaded || savingYear !== null}
          >
            {savingYear === studentYear ? 'جارٍ الحفظ...' : locks[studentYear] ? 'إغلاق التغيير' : 'فتح التغيير'}
          </button>
        </div>
      ))}
      {notice && <p role={notice.error ? 'alert' : 'status'} style={{ margin: '10px 0 0', color: notice.error ? '#b91c1c' : '#166534' }}>{notice.message}</p>}
    </div>
  );
}
