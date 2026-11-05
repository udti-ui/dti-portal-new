'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageCircle, RefreshCw, Send } from 'lucide-react';

type InquiryMessage = {
  id: string;
  inquiry_id: string;
  sender_type: 'student' | 'teacher';
  sender_name: string;
  body: string;
  attachment_name: string | null;
  attachment_url: string | null;
  created_at: string;
};

type Inquiry = {
  id: string;
  student_id: string;
  student_name: string;
  student_year: string;
  student_class: string;
  subject: string;
  status: 'awaiting_teacher' | 'answered';
  updated_at: string;
  messages: InquiryMessage[];
};

const formatDate = (value: string) => new Date(value).toLocaleString('ar-SY', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export default function TeacherInquiriesPanel({
  username,
  password,
}: {
  username: string;
  password: string;
}) {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [reply, setReply] = useState('');
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
      const response = await fetch('/api/teacher-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list-inquiries', username, password }),
      });
      const result = await response.json() as { success?: boolean; error?: string; inquiries?: Inquiry[] };
      if (!response.ok || !result.success) throw new Error(result.error ?? 'تعذر تحميل الاستفسارات.');
      const nextInquiries = result.inquiries ?? [];
      setInquiries(nextInquiries);
      setSelectedId((current) => nextInquiries.some((inquiry) => inquiry.id === current)
        ? current
        : nextInquiries[0]?.id ?? '');
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر تحميل الاستفسارات.', error: true });
    } finally {
      setLoading(false);
    }
  }, [password, username]);

  useEffect(() => {
    void loadInquiries();
  }, [loadInquiries]);

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedInquiry || reply.trim().length < 3) return;
    setSending(true);
    setNotice(null);
    try {
      const response = await fetch('/api/teacher-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply-inquiry',
          username,
          password,
          inquiryId: selectedInquiry.id,
          message: reply.trim(),
        }),
      });
      const result = await response.json() as { success?: boolean; error?: string; telegramSent?: boolean };
      if (!response.ok || !result.success) throw new Error(result.error ?? 'تعذر إرسال الرد.');
      setReply('');
      await loadInquiries();
      setNotice({
        message: result.telegramSent
          ? 'تم إرسال الرد وحُفظ في سجل المحادثة، وأُرسل إشعار تيليجرام للطالب.'
          : 'تم إرسال الرد وحُفظ في سجل المحادثة. تنبيهات تيليجرام لدى الطالب غير مفعّلة أو لم يصل الإشعار.',
        error: false,
      });
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'تعذر إرسال الرد.', error: true });
    } finally {
      setSending(false);
    }
  };

  return (
    <section style={{ display: 'grid', gap: 18, padding: 'clamp(16px, 3vw, 24px)', border: '1px solid var(--page-border)', borderRadius: 16, background: 'var(--page-surface-strong)', color: 'var(--page-text)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '0 0 5px' }}>استفسارات الطلاب</h2>
          <p style={{ margin: 0, color: 'var(--page-text-muted)', fontSize: 13 }}>استفسارات الطلاب في المواد المعيّنة لك؛ الرد محفوظ ويصل للطالب مع إشعار تيليجرام إذا فعّل التنبيهات.</p>
        </div>
        <button type="button" onClick={() => void loadInquiries()} disabled={loading} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 38, padding: '7px 11px', border: '1px solid var(--page-border)', borderRadius: 9, background: 'var(--page-card)', color: 'var(--page-text)', cursor: 'pointer' }}>
          <RefreshCw size={15} /> تحديث
        </button>
      </header>

      {notice && <p role={notice.error ? 'alert' : 'status'} style={{ margin: 0, color: notice.error ? '#a62828' : '#187447', fontWeight: 700 }}>{notice.message}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 16 }}>
        <aside style={{ display: 'grid', alignContent: 'start', gap: 8 }}>
          {loading && <p style={{ color: 'var(--page-text-muted)' }}>جارٍ تحميل الاستفسارات...</p>}
          {!loading && !inquiries.length && <p style={{ color: 'var(--page-text-muted)', lineHeight: 1.7 }}>لا توجد استفسارات في موادك حاليًا.</p>}
          {inquiries.map((inquiry) => (
            <button type="button" key={inquiry.id} onClick={() => setSelectedId(inquiry.id)} style={{ display: 'grid', gap: 5, padding: 12, border: `1px solid ${selectedId === inquiry.id ? '#176b59' : 'var(--page-border)'}`, borderRadius: 10, background: selectedId === inquiry.id ? 'color-mix(in srgb, #176b59 9%, var(--page-card))' : 'var(--page-card)', color: 'var(--page-text)', textAlign: 'right', cursor: 'pointer' }}>
              <strong>{inquiry.student_name} · {inquiry.subject}</strong>
              <small>{inquiry.student_id} · السنة {inquiry.student_year} · {inquiry.status === 'answered' ? 'تم الرد' : 'بانتظار ردك'}</small>
              <span style={{ color: 'var(--page-text-muted)', fontSize: 12 }}>{inquiry.messages[0]?.body.slice(0, 90) || (inquiry.messages[0]?.attachment_name ? `📎 ${inquiry.messages[0].attachment_name}` : '')}</span>
            </button>
          ))}
        </aside>

        <section style={{ minWidth: 0, display: 'grid', alignContent: 'start', gap: 12, padding: 14, border: '1px solid var(--page-border)', borderRadius: 12, background: 'var(--page-card)' }}>
          {selectedInquiry ? (
            <>
              <header style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <MessageCircle size={18} />
                <strong>{selectedInquiry.student_name}</strong>
                <span style={{ color: 'var(--page-text-muted)', fontSize: 13 }}>· {selectedInquiry.subject} · {selectedInquiry.student_class || 'بلا فئة'}</span>
              </header>
              <div style={{ display: 'grid', gap: 9 }}>
                {selectedInquiry.messages.map((item) => (
                  <article key={item.id} style={{ justifySelf: item.sender_type === 'teacher' ? 'end' : 'start', width: 'min(92%, 620px)', padding: 11, border: '1px solid var(--page-border)', borderRadius: 11, background: item.sender_type === 'teacher' ? 'color-mix(in srgb, #176b59 8%, var(--page-card))' : 'var(--page-surface-strong)' }}>
                    <header style={{ display: 'flex', justifyContent: 'space-between', gap: 10, color: 'var(--page-text-muted)', fontSize: 12 }}>
                      <strong style={{ color: 'var(--page-text)' }}>{item.sender_type === 'teacher' ? 'أنت' : item.sender_name}</strong>
                      <time>{formatDate(item.created_at)}</time>
                    </header>
                    {item.body && <p style={{ margin: '8px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.8 }}>{item.body}</p>}
                    {item.attachment_url && item.attachment_name && <a href={item.attachment_url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary-color)', fontWeight: 700 }}>{item.attachment_name}</a>}
                  </article>
                ))}
              </div>
              <form onSubmit={sendReply} style={{ display: 'grid', gap: 9, marginTop: 4 }}>
                <label htmlFor="teacher-inquiry-reply" style={{ fontWeight: 700, fontSize: 13 }}>اكتب ردك</label>
                <textarea id="teacher-inquiry-reply" required minLength={3} maxLength={4000} rows={3} value={reply} onChange={(event) => setReply(event.target.value)} style={{ width: '100%', resize: 'vertical', padding: 11, border: '1px solid var(--page-border)', borderRadius: 10, background: 'var(--page-surface-strong)', color: 'var(--page-text)', font: 'inherit', lineHeight: 1.7 }} />
                <button type="submit" disabled={sending || reply.trim().length < 3} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40, justifySelf: 'start', padding: '8px 14px', border: 0, borderRadius: 9, background: '#176b59', color: '#fff', font: 'inherit', fontWeight: 800, cursor: 'pointer', opacity: sending ? 0.65 : 1 }}>
                  <Send size={15} /> {sending ? 'جارٍ الإرسال...' : 'إرسال الرد'}
                </button>
              </form>
            </>
          ) : <p style={{ margin: 0, color: 'var(--page-text-muted)', lineHeight: 1.7 }}>اختر استفسارًا لقراءة السؤال والرد عليه.</p>}
        </section>
      </div>
    </section>
  );
}
