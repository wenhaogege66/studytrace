export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      ai_reports: {
        Row: {
          content: Json | null
          created_at: string
          cycle_due_at: string | null
          error_code: string | null
          generated_at: string | null
          id: string
          input_hash: string
          input_snapshot: Json
          model_id: string | null
          period_days: number
          read_at: string | null
          source: string
          status: string
          token_usage: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          content?: Json | null
          created_at?: string
          cycle_due_at?: string | null
          error_code?: string | null
          generated_at?: string | null
          id?: string
          input_hash: string
          input_snapshot: Json
          model_id?: string | null
          period_days: number
          read_at?: string | null
          source: string
          status?: string
          token_usage?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: Json | null
          created_at?: string
          cycle_due_at?: string | null
          error_code?: string | null
          generated_at?: string | null
          id?: string
          input_hash?: string
          input_snapshot?: Json
          model_id?: string | null
          period_days?: number
          read_at?: string | null
          source?: string
          status?: string
          token_usage?: Json | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      behavior_events: {
        Row: {
          corrected_direction: string | null
          corrected_type: string | null
          correction_note: string | null
          created_at: string
          direction: string | null
          ended_at: string | null
          event_type: string
          id: string
          observation_metadata: Json
          review_status: string
          session_id: string
          source: string
          started_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          corrected_direction?: string | null
          corrected_type?: string | null
          correction_note?: string | null
          created_at?: string
          direction?: string | null
          ended_at?: string | null
          event_type: string
          id?: string
          observation_metadata?: Json
          review_status?: string
          session_id: string
          source: string
          started_at: string
          updated_at?: string
          user_id: string
        }
        Update: {
          corrected_direction?: string | null
          corrected_type?: string | null
          correction_note?: string | null
          created_at?: string
          direction?: string | null
          ended_at?: string | null
          event_type?: string
          id?: string
          observation_metadata?: Json
          review_status?: string
          session_id?: string
          source?: string
          started_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "behavior_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      observation_runs: {
        Row: {
          camera_version: number
          created_at: string
          detector_version: string
          effective_milliseconds: number
          ended_at: string | null
          experiment_mode: boolean
          id: string
          last_observed_at: string
          observation_profile: string
          origin: string
          policy_snapshot: Json
          session_id: string
          started_at: string
          threshold_snapshot: Json
          user_id: string
        }
        Insert: {
          camera_version?: number
          created_at?: string
          detector_version: string
          effective_milliseconds?: number
          ended_at?: string | null
          experiment_mode?: boolean
          id?: string
          last_observed_at?: string
          observation_profile: string
          origin?: string
          policy_snapshot?: Json
          session_id: string
          started_at: string
          threshold_snapshot?: Json
          user_id: string
        }
        Update: {
          camera_version?: number
          created_at?: string
          detector_version?: string
          effective_milliseconds?: number
          ended_at?: string | null
          experiment_mode?: boolean
          id?: string
          last_observed_at?: string
          observation_profile?: string
          origin?: string
          policy_snapshot?: Json
          session_id?: string
          started_at?: string
          threshold_snapshot?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "observation_runs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      reminder_events: {
        Row: {
          behavior_event_id: string | null
          created_at: string
          id: string
          responded_at: string | null
          response: string
          session_id: string
          shown_at: string
          user_id: string
        }
        Insert: {
          behavior_event_id?: string | null
          created_at?: string
          id?: string
          responded_at?: string | null
          response?: string
          session_id: string
          shown_at?: string
          user_id: string
        }
        Update: {
          behavior_event_id?: string | null
          created_at?: string
          id?: string
          responded_at?: string | null
          response?: string
          session_id?: string
          shown_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminder_events_behavior_event_id_fkey"
            columns: ["behavior_event_id"]
            isOneToOne: false
            referencedRelation: "behavior_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          completion_status: string
          created_at: string
          id: string
          incomplete_reason: string | null
          next_adjustment: string | null
          self_rating: number
          session_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completion_status: string
          created_at?: string
          id?: string
          incomplete_reason?: string | null
          next_adjustment?: string | null
          self_rating: number
          session_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completion_status?: string
          created_at?: string
          id?: string
          incomplete_reason?: string | null
          next_adjustment?: string | null
          self_rating?: number
          session_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_segments: {
        Row: {
          created_at: string
          ended_at: string | null
          id: string
          origin: string
          session_id: string
          started_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          id?: string
          origin?: string
          session_id: string
          started_at: string
          user_id: string
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          id?: string
          origin?: string
          session_id?: string
          started_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_segments_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "study_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      study_sessions: {
        Row: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          accumulated_seconds?: number
          camera_enabled?: boolean
          camera_version?: number
          created_at?: string
          ended_at?: string | null
          energy_before?: string | null
          experiment_mode?: boolean
          id?: string
          observation_agreement?: Json
          observation_profile?: string
          plan_revision_id?: string | null
          reminders_enabled?: boolean
          resumed_at?: string | null
          started_at?: string
          state_version?: number
          status?: string
          target_minutes?: number
          task_id: string
          task_outcome?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          accumulated_seconds?: number
          camera_enabled?: boolean
          camera_version?: number
          created_at?: string
          ended_at?: string | null
          energy_before?: string | null
          experiment_mode?: boolean
          id?: string
          observation_agreement?: Json
          observation_profile?: string
          plan_revision_id?: string | null
          reminders_enabled?: boolean
          resumed_at?: string | null
          started_at?: string
          state_version?: number
          status?: string
          target_minutes?: number
          task_id?: string
          task_outcome?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_plan_revision_owner_fk"
            columns: ["plan_revision_id", "task_id", "user_id"]
            isOneToOne: false
            referencedRelation: "task_plan_revisions"
            referencedColumns: ["id", "task_id", "user_id"]
          },
          {
            foreignKeyName: "study_sessions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_lifecycle_events: {
        Row: {
          created_at: string
          event_type: string
          from_status: string | null
          id: string
          metadata: Json
          occurred_at: string
          task_id: string
          to_status: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          from_status?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          task_id: string
          to_status?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          from_status?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          task_id?: string
          to_status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_lifecycle_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_plan_revisions: {
        Row: {
          changes: Json
          comment: string
          created_at: string
          id: string
          kind: string
          ordinal: number
          request_hash: string | null
          request_id: string | null
          snapshot: Json
          task_id: string
          user_id: string
        }
        Insert: {
          changes?: Json
          comment?: string
          created_at?: string
          id?: string
          kind: string
          ordinal: number
          request_hash?: string | null
          request_id?: string | null
          snapshot: Json
          task_id: string
          user_id: string
        }
        Update: {
          changes?: Json
          comment?: string
          created_at?: string
          id?: string
          kind?: string
          ordinal?: number
          request_hash?: string | null
          request_id?: string | null
          snapshot?: Json
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_plan_revisions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_step_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          next_completed: boolean | null
          next_title: string | null
          occurred_at: string
          previous_completed: boolean | null
          previous_title: string | null
          step_id: string
          task_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          next_completed?: boolean | null
          next_title?: string | null
          occurred_at?: string
          previous_completed?: boolean | null
          previous_title?: string | null
          step_id: string
          task_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          next_completed?: boolean | null
          next_title?: string | null
          occurred_at?: string
          previous_completed?: boolean | null
          previous_title?: string | null
          step_id?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_step_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          completed_at: string | null
          completion_criterion: string
          created_at: string
          current_plan_revision_id: string | null
          due_at: string | null
          estimated_minutes: number
          id: string
          intent_text: string
          learning_purpose: string
          method_summary: string
          observation_agreement: Json
          observation_profile: string
          planning_context: Json
          priority: string
          status: string
          steps: Json
          suggested_session_minutes: number
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          completion_criterion?: string
          created_at?: string
          current_plan_revision_id?: string | null
          due_at?: string | null
          estimated_minutes: number
          id?: string
          intent_text?: string
          learning_purpose?: string
          method_summary?: string
          observation_agreement?: Json
          observation_profile?: string
          planning_context?: Json
          priority?: string
          status?: string
          steps?: Json
          suggested_session_minutes?: number
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          completion_criterion?: string
          created_at?: string
          current_plan_revision_id?: string | null
          due_at?: string | null
          estimated_minutes?: number
          id?: string
          intent_text?: string
          learning_purpose?: string
          method_summary?: string
          observation_agreement?: Json
          observation_profile?: string
          planning_context?: Json
          priority?: string
          status?: string
          steps?: Json
          suggested_session_minutes?: number
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_adopted_revision_owner_fk"
            columns: ["current_plan_revision_id", "id", "user_id"]
            isOneToOne: false
            referencedRelation: "task_plan_revisions"
            referencedColumns: ["id", "task_id", "user_id"]
          },
        ]
      }
      user_consents: {
        Row: {
          feature: string
          granted: boolean
          granted_at: string | null
          revoked_at: string | null
          updated_at: string
          user_id: string
          version: string
        }
        Insert: {
          feature: string
          granted?: boolean
          granted_at?: string | null
          revoked_at?: string | null
          updated_at?: string
          user_id: string
          version: string
        }
        Update: {
          feature?: string
          granted?: boolean
          granted_at?: string | null
          revoked_at?: string | null
          updated_at?: string
          user_id?: string
          version?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          calibration_seconds: number
          camera_enabled_default: boolean
          consent_version: string
          consented_at: string
          created_at: string
          direction_hold_seconds: number
          experiment_mode: boolean
          face_absent_seconds: number
          insights_enabled: boolean
          insights_timezone: string
          neutral_recovery_seconds: number
          pitch_threshold_degrees: number
          privacy_mode: string
          reminder_cooldown_seconds: number
          reminder_delay_seconds: number
          reminders_enabled: boolean
          sample_fps: number
          updated_at: string
          user_id: string
          yaw_threshold_degrees: number
        }
        Insert: {
          calibration_seconds?: number
          camera_enabled_default?: boolean
          consent_version?: string
          consented_at?: string
          created_at?: string
          direction_hold_seconds?: number
          experiment_mode?: boolean
          face_absent_seconds?: number
          insights_enabled?: boolean
          insights_timezone?: string
          neutral_recovery_seconds?: number
          pitch_threshold_degrees?: number
          privacy_mode?: string
          reminder_cooldown_seconds?: number
          reminder_delay_seconds?: number
          reminders_enabled?: boolean
          sample_fps?: number
          updated_at?: string
          user_id: string
          yaw_threshold_degrees?: number
        }
        Update: {
          calibration_seconds?: number
          camera_enabled_default?: boolean
          consent_version?: string
          consented_at?: string
          created_at?: string
          direction_hold_seconds?: number
          experiment_mode?: boolean
          face_absent_seconds?: number
          insights_enabled?: boolean
          insights_timezone?: string
          neutral_recovery_seconds?: number
          pitch_threshold_degrees?: number
          privacy_mode?: string
          reminder_cooldown_seconds?: number
          reminder_delay_seconds?: number
          reminders_enabled?: boolean
          sample_fps?: number
          updated_at?: string
          user_id?: string
          yaw_threshold_degrees?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_account_deletion: { Args: { p_token: string }; Returns: boolean }
      cancel_account_merge: { Args: { p_token: string }; Returns: boolean }
      cancel_study_session: {
        Args: { p_accumulated_seconds: number; p_session_id: string }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      checkpoint_running_session: {
        Args: {
          p_accumulated_seconds: number
          p_checkpointed_at: string
          p_expected_resumed_at: string
          p_session_id: string
        }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      claim_learning_report: {
        Args: { p_days: number; p_source?: string; p_user_id: string }
        Returns: Json
      }
      confirm_task_completion: {
        Args: { p_accumulated_seconds?: number; p_task_id: string }
        Returns: {
          completed_at: string | null
          completion_criterion: string
          created_at: string
          current_plan_revision_id: string | null
          due_at: string | null
          estimated_minutes: number
          id: string
          intent_text: string
          learning_purpose: string
          method_summary: string
          observation_agreement: Json
          observation_profile: string
          planning_context: Json
          priority: string
          status: string
          steps: Json
          suggested_session_minutes: number
          title: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      consume_account_merge: { Args: { p_token: string }; Returns: Json }
      consume_ai_generation_quota: { Args: never; Returns: boolean }
      delete_my_account: { Args: { p_token: string }; Returns: undefined }
      delete_my_data: { Args: never; Returns: undefined }
      delete_my_password_account: { Args: never; Returns: undefined }
      export_my_learning_records: {
        Args: { p_expected_user_id: string; p_offset?: number; p_table: string }
        Returns: Json
      }
      finish_cloud_observation: {
        Args: { p_model: string; p_result: Json; p_window_id: string }
        Returns: Json
      }
      finish_learning_report: {
        Args: {
          p_content: Json
          p_error_code?: string
          p_lease_token: string
          p_model_id: string
          p_report_id: string
          p_token_usage: Json
        }
        Returns: boolean
      }
      finish_study_session: {
        Args: {
          p_accumulated_seconds: number
          p_session_id: string
          p_task_outcome: string
        }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_my_account_transfer_summary: { Args: never; Returns: Json }
      get_my_ai_report_schedule: { Args: never; Returns: Json }
      get_my_consents: { Args: never; Returns: Json }
      get_my_insights: { Args: { p_days?: number }; Returns: Json }
      heartbeat_observation_run: {
        Args: {
          p_camera_version: number
          p_expected_state_version: number
          p_session_id: string
        }
        Returns: string
      }
      list_due_learning_report_users: {
        Args: { p_exclude?: string[]; p_limit?: number }
        Returns: Json
      }
      mark_my_ai_report_read: {
        Args: { p_report_id: string }
        Returns: undefined
      }
      pause_study_session: {
        Args: {
          p_accumulated_seconds: number
          p_expected_state_version: number
          p_session_id: string
        }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      pause_study_session_for_navigation: {
        Args: { p_session_id: string }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      prepare_account_deletion: { Args: { p_token: string }; Returns: string }
      prepare_account_merge: {
        Args: { p_target_email: string; p_token: string }
        Returns: string
      }
      prepare_cloud_observation: {
        Args: {
          p_ended_at: string
          p_session_id: string
          p_started_at: string
          p_window_id: string
        }
        Returns: Json
      }
      record_observation_coverage: {
        Args: {
          p_camera_version: number
          p_expected_state_version: number
          p_sequence: number
          p_session_id: string
          p_valid_milliseconds: number
        }
        Returns: number
      }
      refresh_account_deletion: { Args: { p_token: string }; Returns: string }
      refresh_account_merge: { Args: { p_token: string }; Returns: string }
      reopen_completed_task: {
        Args: { p_task_id: string }
        Returns: {
          completed_at: string | null
          completion_criterion: string
          created_at: string
          current_plan_revision_id: string | null
          due_at: string | null
          estimated_minutes: number
          id: string
          intent_text: string
          learning_purpose: string
          method_summary: string
          observation_agreement: Json
          observation_profile: string
          planning_context: Json
          priority: string
          status: string
          steps: Json
          suggested_session_minutes: number
          title: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      respond_to_reminder: {
        Args: { p_reminder_id: string; p_response: string }
        Returns: {
          behavior_event_id: string | null
          created_at: string
          id: string
          responded_at: string | null
          response: string
          session_id: string
          shown_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "reminder_events"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resume_study_session: {
        Args: { p_expected_state_version: number; p_session_id: string }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_learning_plan: {
        Args: {
          p_expected_revision_id: string
          p_plan: Json
          p_request_id: string
          p_revisions: Json
          p_task_id: string
        }
        Returns: {
          completed_at: string | null
          completion_criterion: string
          created_at: string
          current_plan_revision_id: string | null
          due_at: string | null
          estimated_minutes: number
          id: string
          intent_text: string
          learning_purpose: string
          method_summary: string
          observation_agreement: Json
          observation_profile: string
          planning_context: Json
          priority: string
          status: string
          steps: Json
          suggested_session_minutes: number
          title: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_my_consent: {
        Args: { p_feature: string; p_granted: boolean; p_version: string }
        Returns: Json
      }
      set_study_session_camera: {
        Args: {
          p_camera_version: number
          p_enabled: boolean
          p_expected_state_version: number
          p_session_id: string
        }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_task_step_completed: {
        Args: { p_completed: boolean; p_step_id: string; p_task_id: string }
        Returns: {
          completed_at: string | null
          completion_criterion: string
          created_at: string
          current_plan_revision_id: string | null
          due_at: string | null
          estimated_minutes: number
          id: string
          intent_text: string
          learning_purpose: string
          method_summary: string
          observation_agreement: Json
          observation_profile: string
          planning_context: Json
          priority: string
          status: string
          steps: Json
          suggested_session_minutes: number
          title: string
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_study_session: {
        Args: {
          p_experiment_mode?: boolean
          p_reminders_enabled?: boolean
          p_task_id: string
        }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      touch_my_activity: { Args: never; Returns: string }
      update_my_insights_preferences: {
        Args: { p_enabled: boolean; p_timezone: string }
        Returns: Json
      }
      update_session_learning_context: {
        Args: {
          p_energy_before: string
          p_session_id: string
          p_target_minutes: number
        }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          energy_before: string | null
          experiment_mode: boolean
          id: string
          observation_agreement: Json
          observation_profile: string
          plan_revision_id: string | null
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          target_minutes: number
          task_id: string
          task_outcome: string | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "study_sessions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
