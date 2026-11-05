'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Paperclip, RefreshCw, Send } from 'lucide-react';

type InquiryMessage = {
  id: string;
  inquiry_id: string;
  sender_type: 'student' | 'teacher';
  sender_name: string;
  body: string;
  attachment_name: string | null;
  attachment_type: string | null;
  attachment_url: string | null;
  created_at: string;
};

type Inquiry = {
  id: string;
  subject: string;
  student_year: string;
  status: 'awaiting_teacher' | 'answered';
  created_at: string;
  updated_at: string;
  messages: InquiryMessage[];
};

type SubjectOption = { year: string; name: string; teachers: string[] };

const formatDate = (value: string) => new Date(value).toLocaleString('ar-SY', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default function StudentTeacherInquiries({
  studentId,
  password,
}: {
  studentId: string;
  password: string;
}) {
  const [subjects, setSubjects] = useState<SubjectOption[]>([]);
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedSubject, setSelectedSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);

  const selectedInquiry = useMemo(
    () => inquiries.find((inquiry) => inquiry.id === selectedId) ?? null,
    [inquiries, selectedId],
  );

  const loadInquiries = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const response = await fetch('/api/student/inquiries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', studentId, password }),
      });
      const result = await response.json() as {
        success?: boolean;
        error?: string;
        subjects?: SubjectOption[];
        inquiries?: Inquiry[];
      };
      if (!response.ok || !result.success) throw new Error(result.error ?? 'تعذر تحميل سجل الاستفسارات.');
      const nextSubjects = result.subjects ?? [];
      const nextInquiries = result.inquiries ?? [];
      setSubjects(nextSubjects);
      setInquiries(nextInquiries);
      setSelectedYear((current) => nextSubjects.some((subject) => subject.year === current) ? current : '');
      setSelectedId((current) => nextInquiries.some((inquiry) => inquiry.id === current)
        ? current
        : nextInquiries[0]?.id ?? '');
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر تحميل سجل الاستفسارات.', error: true });
    } finally {
      setLoading(false);
    }
  }, [password, studentId]);

  useEffect(() => {
    void loadInquiries();
  }, [loadInquiries]);

  const submitInquiry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedYear || !selectedSubject || message.trim().length < 3) return;
    if (attachment && attachment.size > 5 * 1024 * 1024) {
      setNotice({ message: 'حجم المرفق يجب ألا يتجاوز 5 ميغابايت.', error: true });
      return;
    }

    setSending(true);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.set('action', 'create');
      formData.set('studentId', studentId);
      formData.set('password', password);
      formData.set('studentYear', selectedYear);
      formData.set('subject', selectedSubject);
      formData.set('message', message.trim());
      if (attachment) formData.set('attachment', attachment);

      const response = await fetch('/api/student/inquiries', { method: 'POST', body: formData });
      const result = await response.json() as {
        success?: boolean;
        error?: string;
        notificationsSent?: number;
        notificationTargets?: number;
      };
      if (!response.ok || !result.success) {
        const messages: Record<string, string> = {
          'inquiry-attachment-invalid': 'نوع الملف غير مدعوم أو تجاوز حجمه 5 ميغابايت.',
          'inquiry-no-active-teachers': 'لا يوجد مدرس نشط معيّن لهذه المادة حاليًا.',
          'inquiry-subject-not-assigned': 'المادة المحددة غير متاحة لحسابك.',
          'student-credentials-invalid': 'انتهت صلاحية تسجيل الدخول. أعد تسجيل الدخول ثم حاول مجددًا.',
        };
        throw new Error(messages[result.error ?? ''] ?? 'تعذر إرسال الاستفسار.');
      }
      setMessage('');
      setAttachment(null);
      setSelectedId('');
      await loadInquiries();
      const notificationMessage = (result.notificationsSent ?? 0) > 0
        ? 'وصل إشعار تيليجرام إلى مدرس المادة.'
        : (result.notificationTargets ?? 0) > 0
          ? 'حُفظ الاستفسار، لكن تعذر إرسال إشعار تيليجرام للمدرس.'
          : 'حُفظ الاستفسار. لا يوجد حساب تيليجرام مربوط للمدرس حاليًا.';
      setNotice({ message: `تم إرسال استفسارك وحفظه في السجل. ${notificationMessage}`, error: false });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر إرسال الاستفسار.', error: true });
    } finally {
      setSending(false);
    }
  };

  const yearSubjects = subjects.filter((subject) => subject.year === selectedYear);

  return (
    <section style={{ display: 'grid', gap: 20, padding: 'clamp(16px, 3vw, 26px)', border: '1px solid #dce8e2', borderRadius: 18, background: '#fff', color: '#18332c' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '0 0 6px', fontSize: 22 }}>تواصل مع المدرس</h2>
          <p style={{ margin: 0, color: '#64756f', lineHeight: 1.7 }}>اختر السنة الدراسية أولًا ثم المادة، واكتب استفسارك لمتابعة الرد في سجل المحادثة.</p>
        </div>
        <button type="button" onClick={() => void loadInquiries()} disabled={loading} aria-label="تحديث سجل الاستفسارات" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 40, padding: '8px 12px', border: '1px solid #dce8e2', borderRadius: 10, background: '#fff', color: '#28594e', cursor: 'pointer' }}>
          <RefreshCw size={16} aria-hidden="true" /> تحديث
        </button>
      </header>

      <form onSubmit={submitInquiry} style={{ display: 'grid', gap: 12, padding: 16, borderRadius: 14, background: '#f5f8f6' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 7, fontWeight: 700, fontSize: 14 }}>
            السنة الدراسية
            <select required value={selectedYear} onChange={(event) => {
              const year = event.target.value;
              setSelectedYear(year);
              setSelectedSubject('');
            }} disabled={!subjects.length || sending} style={{ minHeight: 44, padding: '9px 12px', border: '1px solid #d3e0da', borderRadius: 10, background: '#fff', color: '#18332c', font: 'inherit' }}>
              <option value="">اختر السنة</option>
              {[...new Set(subjects.map((subject) => subject.year))].map((year) => <option value={year} key={year}>{year}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 7, fontWeight: 700, fontSize: 14 }}>
            المادة
            <select required value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!selectedYear || !yearSubjects.length || sending} style={{ minHeight: 44, padding: '9px 12px', border: '1px solid #d3e0da', borderRadius: 10, background: '#fff', color: '#18332c', font: 'inherit' }}>
              <option value="">{selectedYear ? 'اختر المادة' : 'اختر السنة أولًا'}</option>
              {yearSubjects.map((subject) => <option value={subject.name} key={`${subject.year}-${subject.name}`}>{subject.name}</option>)}
            </select>
          </label>
        </div>
        {!subjects.length && !loading && <small style={{ color: '#a62828' }}>لا توجد مواد مرتبطة بمدرسين حاليًا.</small>}
        {selectedSubject && <small style={{ color: '#64756f' }}>
          المدرس: {yearSubjects.find((subject) => subject.name === selectedSubject)?.teachers.join('، ') || 'مدرسو المادة'}
        </small>}
        <label style={{ display: 'grid', gap: 7, fontWeight: 700, fontSize: 14 }}>
          الاستفسار
          <textarea required minLength={3} maxLength={4000} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="اكتب سؤالك أو استفسارك هنا..." style={{ width: '100%', resize: 'vertical', padding: 12, border: '1px solid #d3e0da', borderRadius: 10, background: '#fff', color: '#18332c', font: 'inherit', lineHeight: 1.7 }} />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 42, padding: '8px 12px', border: '1px solid #d3e0da', borderRadius: 10, background: '#fff', color: '#28594e', fontWeight: 700, cursor: 'pointer' }}>
            <Paperclip size={17} aria-hidden="true" /> إرفاق صورة أو ملف
            <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setAttachment(event.target.files?.[0] ?? null)} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }} />
          </label>
          {attachment && <span style={{ color: '#64756f', fontSize: 13 }}>{attachment.name} <button type="button" onClick={() => setAttachment(null)} aria-label="إزالة المرفق" style={{ border: 0, background: 'none', color: '#a33', cursor: 'pointer' }}>إزالة</button></span>}
          <button type="submit" disabled={sending || !selectedYear || !selectedSubject || message.trim().length < 3} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 42, marginInlineStart: 'auto', padding: '9px 16px', border: 0, borderRadius: 10, background: '#176b59', color: '#fff', font: 'inherit', fontWeight: 800, cursor: 'pointer', opacity: sending || !selectedYear || !selectedSubject ? 0.65 : 1 }}>
            <Send size={16} aria-hidden="true" /> {sending ? 'جارٍ الإرسال...' : 'إرسال الاستفسار'}
          </button>
        </div>
        <small style={{ color: '#64756f' }}>الصور وملفات PDF وWord والنصوص — بحد أقصى 5 ميغابايت.</small>
      </form>

      {notice && <p role={notice.error ? 'alert' : 'status'} style={{ margin: 0, color: notice.error ? '#a62828' : '#187447', fontWeight: 700 }}>{notice.message}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 16 }}>
        <aside style={{ display: 'grid', alignContent: 'start', gap: 8 }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16 }}>سجل الاستفسارات</h3>
          {loading && <p style={{ color: '#64756f' }}>جارٍ تحميل السجل...</p>}
          {!loading && !inquiries.length && <p style={{ color: '#64756f', lineHeight: 1.7 }}>لم ترسل استفسارات بعد.</p>}
          {inquiries.map((inquiry) => (
            <button type="button" key={inquiry.id} onClick={() => setSelectedId(inquiry.id)} style={{ display: 'grid', gap: 5, padding: 12, border: `1px solid ${selectedId === inquiry.id ? '#176b59' : '#dce8e2'}`, borderRadius: 11, background: selectedId === inquiry.id ? '#edf7f2' : '#fff', color: '#18332c', textAlign: 'right', cursor: 'pointer' }}>
              <strong>{inquiry.subject}</strong>
              <small>{inquiry.status === 'answered' ? 'تم الرد' : 'بانتظار رد المدرس'} · {formatDate(inquiry.updated_at)}</small>
              <span style={{ color: '#64756f', fontSize: 12 }}>{inquiry.messages[0]?.body.slice(0, 90) || (inquiry.messages[0]?.attachment_name ? `📎 ${inquiry.messages[0].attachment_name}` : '')}</span>
            </button>
          ))}
        </aside>

        <section style={{ minWidth: 0, padding: 14, border: '1px solid #e1ebe5', borderRadius: 14, background: '#fbfdfc' }}>
          {selectedInquiry ? (
            <>
              <h3 style={{ margin: '0 0 12px' }}>{selectedInquiry.subject} <small style={{ color: '#64756f', fontWeight: 500 }}>· {selectedInquiry.student_year}</small></h3>
              <div style={{ display: 'grid', gap: 10 }}>
                {selectedInquiry.messages.map((item) => (
                  <article key={item.id} style={{ justifySelf: item.sender_type === 'student' ? 'start' : 'end', width: 'min(92%, 620px)', padding: 12, border: '1px solid #e1ebe5', borderRadius: 12, background: item.sender_type === 'student' ? '#edf7f2' : '#fff' }}>
                    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: '#64756f', fontSize: 12 }}>
                      <strong style={{ color: '#28594e' }}>{item.sender_type === 'student' ? 'أنت' : item.sender_name}</strong>
                      <time>{formatDate(item.created_at)}</time>
                    </header>
                    {item.body && <p style={{ margin: '9px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8 }}>{item.body}</p>}
                    {item.attachment_url && item.attachment_name && <a href={item.attachment_url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: '#176b59', fontWeight: 700 }}><Paperclip size={15} />{item.attachment_name}</a>}
                  </article>
                ))}
              </div>
            </>
          ) : <p style={{ margin: 0, color: '#64756f', lineHeight: 1.7 }}>اختر استفسارًا من السجل لعرض المحادثة والرد.</p>}
        </section>
      </div>
    </section>
  );
}
