import type { Database as GeneratedDatabase } from "./database"
export type { Json } from "./database"

type Functions = GeneratedDatabase["public"]["Functions"]
type NullableRpcOverrides = {
  // PostgreSQL function arguments accept SQL NULL; the CLI generator does not
  // infer argument nullability. Keep these two documented overrides separate
  // so database.ts remains reproducibly generated.
  save_learning_plan: Omit<Functions["save_learning_plan"], "Args"> & {
    Args: Omit<
      Functions["save_learning_plan"]["Args"],
      "p_task_id" | "p_expected_revision_id"
    > & {
      p_task_id: string | null
      p_expected_revision_id: string | null
    }
  }
  update_session_learning_context: Omit<
    Functions["update_session_learning_context"],
    "Args"
  > & {
    Args: Omit<
      Functions["update_session_learning_context"]["Args"],
      "p_energy_before"
    > & { p_energy_before: string | null }
  }
}
export type Database = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedDatabase["public"], "Functions"> & {
    Functions: Omit<Functions, keyof NullableRpcOverrides> &
      NullableRpcOverrides
  }
}
