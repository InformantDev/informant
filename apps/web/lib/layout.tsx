import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { RadioTower } from "lucide-react";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="brand-lockup">
        <RadioTower size={18} /> Informant <small>LOCAL CI</small>
      </span>
    ),
  },
  githubUrl: "https://github.com/InformantDev/informant",
};
