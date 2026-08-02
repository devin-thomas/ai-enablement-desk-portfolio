create unique index if not exists artifacts_original_request_narration_success_idx
  on artifacts (request_id, artifact_type)
  where artifact_type = 'original_request_narration' and status = 'success';
