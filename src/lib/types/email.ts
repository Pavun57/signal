export interface EmailSettings {
  gmail_address: string | null;
  gmail_connected_at: string | null;
  from_name: string | null;
  reply_to_email: string | null;
  daily_send_limit: number;
  is_configured: boolean;
}

export interface EmailDraft {
  id: string;
  campaign_id: string;
  person_id: string;
  campaign_people_id: string;
  user_id: string;
  to_email: string;
  subject: string;
  body_html: string;
  body_text: string | null;
  reply_to: string | null;
  status: "draft" | "queued" | "sent" | "discarded";
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SentEmail {
  id: string;
  /** RFC 5322 Message-ID of the sent mail — the reply-tracking match key. */
  message_id: string | null;
  draft_id: string | null;
  campaign_people_id: string;
  campaign_id: string;
  person_id: string;
  user_id: string;
  to_email: string;
  from_email: string;
  subject: string;
  status: string;
  sent_at: string;
  created_at: string;
}
