// Real database wiring for DispatchDeps (minus sendPush/vapidConfigured,
// see index.ts) -- a service-role Supabase client, scoped to exactly the
// grants migration 0054 adds (notifications/profiles SELECT,
// push_subscriptions SELECT+DELETE, push_deliveries SELECT+INSERT+UPDATE).
// Never accepts a client-supplied credential; the service-role key comes
// solely from this function's own environment.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotificationRow, SubscriptionRow } from "./types.ts";

/** Postgres/PostgREST's unique_violation code -- the push_deliveries
 *  (notification_id, subscription_id) constraint (migration 0053) is the
 *  actual atomic claim boundary; this is how a losing concurrent claim
 *  attempt is recognized. */
const UNIQUE_VIOLATION = "23505";

export function createDatabaseDeps(client: SupabaseClient) {
  return {
    async fetchNotification(id: string): Promise<NotificationRow | null> {
      const { data, error } = await client
        .from("notifications")
        .select("id, user_id, type, category, incident_id, actor_id, push_eligible")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return (data as NotificationRow | null) ?? null;
    },

    async isRecipientActive(userId: string): Promise<boolean> {
      const { data, error } = await client.from("profiles").select("active").eq(
        "id",
        userId,
      ).maybeSingle();
      if (error) throw error;
      return data?.active === true;
    },

    async fetchActorDisplayName(actorId: string): Promise<string | null> {
      // full_name ONLY -- never email, never any other profile field. A
      // missing profile or a blank name is not an error, just "unresolved".
      const { data, error } = await client
        .from("profiles")
        .select("full_name")
        .eq("id", actorId)
        .maybeSingle();
      if (error) throw error;
      const name = data?.full_name;
      return typeof name === "string" && name.trim().length > 0
        ? name.trim()
        : null;
    },

    async fetchSubscriptions(userId: string): Promise<SubscriptionRow[]> {
      const { data, error } = await client
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth_key")
        .eq("user_id", userId);
      if (error) throw error;
      return (data as SubscriptionRow[] | null) ?? [];
    },

    async claimDelivery(
      notificationId: string,
      subscriptionId: string,
    ): Promise<boolean> {
      const { error } = await client
        .from("push_deliveries")
        .insert({
          notification_id: notificationId,
          subscription_id: subscriptionId,
          status: "pending",
        });
      if (error) {
        if (error.code === UNIQUE_VIOLATION) return false;
        throw error;
      }
      return true;
    },

    async markDeliverySent(
      notificationId: string,
      subscriptionId: string,
      httpStatus?: number,
    ): Promise<void> {
      const { error } = await client
        .from("push_deliveries")
        .update({
          status: "sent",
          http_status: httpStatus ?? null,
          attempted_at: new Date().toISOString(),
        })
        .eq("notification_id", notificationId)
        .eq("subscription_id", subscriptionId);
      if (error) throw error;
    },

    async markDeliveryFailed(
      notificationId: string,
      subscriptionId: string,
      errorMessage: string,
      httpStatus?: number,
    ): Promise<void> {
      const { error } = await client
        .from("push_deliveries")
        .update({
          status: "failed",
          http_status: httpStatus ?? null,
          error: errorMessage,
          attempted_at: new Date().toISOString(),
        })
        .eq("notification_id", notificationId)
        .eq("subscription_id", subscriptionId);
      if (error) throw error;
    },

    async markDeliveryExpired(
      notificationId: string,
      subscriptionId: string,
      httpStatus?: number,
    ): Promise<void> {
      const { error } = await client
        .from("push_deliveries")
        .update({
          status: "expired",
          http_status: httpStatus ?? null,
          attempted_at: new Date().toISOString(),
        })
        .eq("notification_id", notificationId)
        .eq("subscription_id", subscriptionId);
      if (error) throw error;
    },

    async removeSubscription(subscriptionId: string): Promise<void> {
      const { error } = await client.from("push_subscriptions").delete().eq(
        "id",
        subscriptionId,
      );
      if (error) throw error;
    },
  };
}
