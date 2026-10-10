-- Microsoft can reject a COMMITTED delta token with 410 Gone / syncStateNotFound.
-- Only that explicit worker reason clears both committed cursors and the shared round.
-- Ordinary nextLink/TTL resets still preserve them. The existing two-folder lease fence,
-- signature, grants and all other function-body lines are retained.
-- No candidate, saved interaction, contact, dedup reference or wake-up is changed here.
-- Apply before deploying the worker. This migration itself does not reset a connection.

CREATE OR REPLACE FUNCTION public.reset_outlook_round(
  p_connection_id uuid,
  p_run_id        uuid,
  p_reason        text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n       integer;
  v_deleted integer;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 100 THEN
    RETURN jsonb_build_object('result', 'invalid_reason');
  END IF;

  PERFORM 1 FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id FOR SHARE;

  SELECT count(*) INTO v_n FROM public.outlook_sync_state s
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id = p_run_id
     AND s.sync_status = 'running'
     AND s.sync_lease_until > now();
  IF v_n <> 2 THEN
    RETURN jsonb_build_object('result', 'stale_run');
  END IF;

  DELETE FROM public.outlook_conversation_progress p
   WHERE p.connection_id = p_connection_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE public.outlook_sync_state s
     SET round_id                    = NULL,
         round_started_at            = NULL,
         round_expires_at            = NULL,
         round_pages                 = 0,
         round_messages              = 0,
         round_page_seq              = 0,
         round_messages_dropped      = 0,
         round_conversations_dropped = 0,
         round_folder_complete       = false,
         round_write_cursor          = NULL,
         next_link_ciphertext        = NULL,
         next_link_nonce             = NULL,
         next_link_key_version       = NULL,
         pending_delta_ciphertext    = NULL,
         pending_delta_nonce         = NULL,
         pending_delta_key_version   = NULL,
         -- >>> committed-delta recovery: all other resets retain these columns.
         delta_link_ciphertext       = CASE WHEN p_reason = 'committed_delta_rejected'
                                            THEN NULL ELSE s.delta_link_ciphertext END,
         delta_link_nonce            = CASE WHEN p_reason = 'committed_delta_rejected'
                                            THEN NULL ELSE s.delta_link_nonce END,
         -- <<< committed-delta recovery
         last_error_code             = COALESCE(p_reason, s.last_error_code),
         updated_at                  = now()
   WHERE s.connection_id = p_connection_id
     AND s.sync_run_id   = p_run_id
     AND s.sync_status   = 'running';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'lease_lost_during_reset';
  END IF;

  RETURN jsonb_build_object('result', 'reset', 'conversations_deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.reset_outlook_round(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_outlook_round(uuid, uuid, text) TO service_role;
