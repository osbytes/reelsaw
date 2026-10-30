import { Logo } from "../App";

/** Header row of the centred auth cards: the title on the left, the logo top-right on the same line. */
export function AuthCardHeader({ title, titleClassName = "text-[26px]" }: { title: string; titleClassName?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className={`min-w-0 font-bold tracking-tight ${titleClassName}`}>{title}</h1>
      <Logo />
    </div>
  );
}
