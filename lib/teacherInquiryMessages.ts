import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function getInquiryMessages(
  supabase: SupabaseClient,
  inquiryIds: string[]
) {
  if (!inquiryIds.length) return [];

  const { data, error } = await supabase.from('teacher_inquiry_messages')
    .select('id, inquiry_id, sender_type, sender_id, sender_name, body, attachment_path, attachment_name, attachment_type, attachment_size, created_at')
    .in('inquiry_id', inquiryIds)
    .order('created_at', { ascending: true });
  if (error) throw error;

  return Promise.all((data ?? []).map(async (message) => {
    let attachmentUrl: string | null = null;
    if (message.attachment_path) {
      const { data: signedUrl, error: signedUrlError } = await supabase.storage
        .from('announcements')
        .createSignedUrl(String(message.attachment_path), 60 * 60);
      if (signedUrlError || !signedUrl?.signedUrl) {
        console.error('TEACHER_INQUIRY_ATTACHMENT_LINK_FAILED:', signedUrlError?.message ?? 'Signed URL missing');
        throw new Error('inquiry-attachment-link-failed');
      }
      attachmentUrl = signedUrl.signedUrl;
    }

    return {
      id: String(message.id),
      inquiry_id: String(message.inquiry_id),
      sender_type: message.sender_type,
      sender_id: String(message.sender_id),
      sender_name: String(message.sender_name),
      body: String(message.body ?? ''),
      attachment_name: message.attachment_name ? String(message.attachment_name) : null,
      attachment_type: message.attachment_type ? String(message.attachment_type) : null,
      attachment_size: typeof message.attachment_size === 'number' ? message.attachment_size : null,
      attachment_url: attachmentUrl,
      created_at: String(message.created_at),
    };
  }));
}
