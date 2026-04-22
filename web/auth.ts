import NextAuth from "next-auth"
import Google from "next-auth/providers/google"

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  trustHost: true,
  callbacks: {
    async signIn({ profile }) {
      const allowed = process.env.AUTH_ALLOWED_EMAIL
      return !allowed || profile?.email === allowed
    },
  },
})
