import { AskPage } from './ask-page';
import { ThemeToggle } from './components/theme-toggle';

export function App() {
  return (
    <>
      <header className="flex h-12 items-center justify-between border-b border-border px-4">
        <p className="text-sm font-medium">agent-works</p>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-2xl px-4 pt-10 pb-12">
        <h1 className="text-2xl">Ask</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Answers cite the documents they came from. Every question is recorded in the audit log.
        </p>
        <AskPage />
      </main>
    </>
  );
}
