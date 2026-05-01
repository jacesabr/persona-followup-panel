import { Component } from "react";

// Top-level safety net for unhandled render exceptions. React doesn't
// have a hooks-based equivalent — class component is the only API.
//
// Without this, an exception thrown anywhere in the tree unmounts the
// whole app and leaves the user staring at a blank page with the error
// only visible in devtools. Here we render a recovery prompt instead so
// they can at least reload.
//
// We deliberately don't try to "recover" by resetting state and
// re-rendering the same broken tree — that usually loops. Reload is
// the safe choice; the auth cookie persists so the user's session
// isn't lost.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="flex min-h-screen w-full items-center justify-center px-6 font-serif text-stone-900"
        style={{ backgroundColor: "#faf9f5" }}
      >
        <div className="w-full max-w-md border border-stone-300 bg-white p-10 text-center">
          <p className="text-[12px] uppercase tracking-[0.3em] text-[#cc785c]">
            Something went wrong
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">
            The panel hit an unexpected error.
          </h1>
          <p className="mt-3 text-sm text-stone-600">
            Your session is still active — a reload should put you back
            where you were. If it keeps happening, let admin know.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex w-full items-center justify-center border border-[#cc785c] bg-[#cc785c] px-6 py-3 text-xs uppercase tracking-[0.25em] text-white hover:bg-[#b86a4f]"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
