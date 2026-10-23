import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";

export const authClient = createAuthClient({ baseURL: window.location.origin, plugins: [apiKeyClient()] });
export const { useSession, signIn, signUp, signOut, sendVerificationEmail } = authClient;
