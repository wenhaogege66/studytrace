export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
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
      study_sessions: {
        Row: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
          task_outcome: string | null
          task_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accumulated_seconds?: number
          camera_enabled?: boolean
          camera_version?: number
          created_at?: string
          ended_at?: string | null
          experiment_mode?: boolean
          id?: string
          observation_profile?: string
          reminders_enabled?: boolean
          resumed_at?: string | null
          started_at?: string
          state_version?: number
          status?: string
          task_outcome?: string | null
          task_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accumulated_seconds?: number
          camera_enabled?: boolean
          camera_version?: number
          created_at?: string
          ended_at?: string | null
          experiment_mode?: boolean
          id?: string
          observation_profile?: string
          reminders_enabled?: boolean
          resumed_at?: string | null
          started_at?: string
          state_version?: number
          status?: string
          task_outcome?: string | null
          task_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_sessions_task_id_fkey"
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
          created_at: string
          estimated_minutes: number
          id: string
          observation_profile: string
          priority: string
          status: string
          steps: Json
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          estimated_minutes: number
          id?: string
          observation_profile?: string
          priority?: string
          status?: string
          steps?: Json
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          estimated_minutes?: number
          id?: string
          observation_profile?: string
          priority?: string
          status?: string
          steps?: Json
          title?: string
          updated_at?: string
          user_id?: string
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
      cancel_study_session: {
        Args: { p_accumulated_seconds: number; p_session_id: string }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
      confirm_task_completion: {
        Args: { p_accumulated_seconds?: number; p_task_id: string }
        Returns: {
          completed_at: string | null
          created_at: string
          estimated_minutes: number
          id: string
          observation_profile: string
          priority: string
          status: string
          steps: Json
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
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
      consume_account_merge: {
        Args: { p_token: string }
        Returns: Json
      }
      cancel_account_deletion: {
        Args: { p_token: string }
        Returns: boolean
      }
      cancel_account_merge: {
        Args: { p_token: string }
        Returns: boolean
      }
      consume_ai_generation_quota: { Args: never; Returns: boolean }
      delete_my_account: {
        Args: { p_token: string }
        Returns: undefined
      }
      delete_my_data: { Args: never; Returns: undefined }
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
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
      prepare_account_deletion: {
        Args: { p_token: string }
        Returns: string
      }
      prepare_account_merge: {
        Args: { p_target_email: string; p_token: string }
        Returns: string
      }
      refresh_account_deletion: {
        Args: { p_token: string }
        Returns: string
      }
      refresh_account_merge: {
        Args: { p_token: string }
        Returns: string
      }
      reopen_completed_task: {
        Args: { p_task_id: string }
        Returns: {
          completed_at: string | null
          created_at: string
          estimated_minutes: number
          id: string
          observation_profile: string
          priority: string
          status: string
          steps: Json
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
      resume_study_session: {
        Args: { p_expected_state_version: number; p_session_id: string }
        Returns: {
          accumulated_seconds: number
          camera_enabled: boolean
          camera_version: number
          created_at: string
          ended_at: string | null
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
        Args: {
          p_completed: boolean
          p_step_id: string
          p_task_id: string
        }
        Returns: {
          completed_at: string | null
          created_at: string
          estimated_minutes: number
          id: string
          observation_profile: string
          priority: string
          status: string
          steps: Json
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
          experiment_mode: boolean
          id: string
          observation_profile: string
          reminders_enabled: boolean
          resumed_at: string | null
          started_at: string
          state_version: number
          status: string
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
