export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen bg-surface text-primary flex flex-col overflow-hidden">
      {children}
    </div>
  );
}
