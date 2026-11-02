"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Logo } from "./Logo";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      if (mode === "register" && form.password !== form.confirm) throw new Error("Passwords do not match");
      const { confirm: _confirm, ...body } = form;
      void _confirm;
      const res = await api<{ role?: string }>(`/api/auth/${mode}`, { body });
      // Small delay to ensure cookie is set before redirect
      await new Promise(resolve => setTimeout(resolve, 100));
      router.push(res.role === "ADMIN" ? "/admin" : "/trade");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
          <h1 className="text-lg font-semibold text-white">{mode === "login" ? "Sign in to your account" : "Open a trading account"}</h1>
          {mode === "register" && (
            <>
              <div>
                <label className="label" htmlFor="name">Full name</label>
                <input className="input" id="name" name="name" required minLength={2} autoComplete="name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="phone">Phone</label>
                  <input className="input" id="phone" name="phone" placeholder="+254..." autoComplete="tel" />
                </div>
                <div>
                  <label className="label" htmlFor="country">Country</label>
                  <input className="input" id="country" name="country" placeholder="Kenya" autoComplete="country-name" />
                </div>
              </div>
            </>
          )}
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input className="input" id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              required
              minLength={mode === "register" ? 8 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {mode === "register" && (
            <div>
              <label className="label" htmlFor="confirm">Confirm password</label>
              <input className="input" id="confirm" name="confirm" type="password" required minLength={8} autoComplete="new-password" />
            </div>
          )}
          {error && <p className="rounded bg-down/10 px-3 py-2 text-sm text-down">{error}</p>}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
          {mode === "register" && (
            <p className="text-xs text-slate-500">
              You get a demo account with $10,000 virtual funds and a live account you can fund from the wallet.
            </p>
          )}
        </form>
        <p className="mt-4 text-center text-sm text-slate-400">
          {mode === "login" ? (
            <>New here? <Link href="/register" className="text-brand-400 hover:underline">Create an account</Link></>
          ) : (
            <>Already have an account? <Link href="/login" className="text-brand-400 hover:underline">Sign in</Link></>
          )}
        </p>
      </div>
    </div>
  );
}
