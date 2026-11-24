"use client";

import { Languages, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Link } from "@/i18n/navigation";
import { OfflineSignOutForm } from "@/modules/offline/components/sign-out-form";
import { LocaleSwitcher } from "../locale-switcher";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { initialsOf } from "./initials";
import { NavIcon } from "./nav-icons";
import type { ShellNavItem } from "./types";

export interface UserMenuLabels {
  open: string;
  theme: string;
  light: string;
  dark: string;
  system: string;
  language: string;
  signOut: string;
}

/**
 * The account menu: who is signed in, personal links (My security), theme
 * (light / dark / system), language and sign-out. Sign-out runs through
 * OfflineSignOutForm (it clears this device's offline queue first), so its item
 * keeps the menu open (`preventDefault` on select) until the form has submitted.
 */
export function UserMenu({
  name,
  subtitle,
  links,
  userId,
  signOutAction,
  dir,
  labels,
}: {
  name: string;
  subtitle: string | null;
  links: ShellNavItem[];
  userId: string;
  signOutAction: (formData: FormData) => void | Promise<void>;
  dir: "rtl" | "ltr";
  labels: UserMenuLabels;
}) {
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu dir={dir}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={labels.open} className="rounded-full">
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
          >
            {initialsOf(name) || "·"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate">{name}</span>
          {subtitle ? <span className="truncate text-xs font-normal text-muted-foreground">{subtitle}</span> : null}
        </DropdownMenuLabel>
        {links.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {links.map((link) => (
                <DropdownMenuItem key={link.href} asChild>
                  <Link href={link.href}>
                    <NavIcon icon={link.icon} />
                    {link.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{labels.theme}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light" onSelect={(e) => e.preventDefault()}>
            <Sun aria-hidden="true" />
            {labels.light}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" onSelect={(e) => e.preventDefault()}>
            <Moon aria-hidden="true" />
            {labels.dark}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" onSelect={(e) => e.preventDefault()}>
            <Monitor aria-hidden="true" />
            {labels.system}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <LocaleSwitcher className="text-foreground no-underline hover:no-underline">
            <Languages aria-hidden="true" />
            <span>{labels.language}</span>
          </LocaleSwitcher>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <OfflineSignOutForm userId={userId} action={signOutAction}>
          <DropdownMenuItem asChild variant="destructive" onSelect={(e) => e.preventDefault()}>
            <button type="submit" className="w-full">
              <LogOut aria-hidden="true" />
              {labels.signOut}
            </button>
          </DropdownMenuItem>
        </OfflineSignOutForm>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
