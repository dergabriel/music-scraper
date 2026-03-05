import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import * as Chakra from 'https://esm.sh/@chakra-ui/react@2.10.9?deps=react@18.3.1,react-dom@18.3.1&bundle';
import * as Icons from 'https://esm.sh/@chakra-ui/icons@2.1.1?deps=react@18.3.1,react-dom@18.3.1&bundle';
import htm from 'https://esm.sh/htm@3.1.1';

export const html = htm.bind(React.createElement);

export const horizonTheme = Chakra.extendTheme({
  config: {
    initialColorMode: 'light',
    useSystemColorMode: false
  },
  fonts: {
    heading: 'Plus Jakarta Sans, system-ui, sans-serif',
    body: 'Plus Jakarta Sans, system-ui, sans-serif'
  },
  colors: {
    brand: {
      50: '#e9f3ff',
      100: '#c8dfff',
      200: '#a4c9ff',
      300: '#7ab2ff',
      400: '#589dff',
      500: '#367ff5',
      600: '#275fbe',
      700: '#1c4589',
      800: '#142f5d',
      900: '#0a1832'
    },
    navy: {
      50: '#f4f7fe',
      100: '#e6ecf9',
      200: '#cad6f0',
      300: '#a2b9e2',
      400: '#7c9ad4',
      500: '#5f7ec4',
      600: '#4562a3',
      700: '#30467a',
      800: '#1f3154',
      900: '#111f36'
    }
  },
  semanticTokens: {
    colors: {
      appBg: { default: 'navy.50', _dark: '#0b1220' },
      shellBg: { default: 'white', _dark: '#0f172a' },
      cardBg: { default: 'white', _dark: '#111827' },
      lineColor: { default: 'navy.100', _dark: 'whiteAlpha.200' },
      textPrimary: { default: 'navy.800', _dark: 'gray.100' },
      textMuted: { default: 'navy.500', _dark: 'gray.400' }
    }
  },
  styles: {
    global: {
      body: {
        bg: 'appBg',
        color: 'textPrimary'
      }
    }
  }
});

export const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', key: 'dashboard' },
  { href: '/tracks', label: 'Statistik', key: 'tracks' },
  { href: '/new-titles', label: 'Neue Titel', key: 'new-titles' },
  { href: '/backpool', label: 'Backpool', key: 'backpool' },
  { href: '/api/docs', label: 'API', key: 'api', external: true }
];

function ThemeToggleButton() {
  const { colorMode, toggleColorMode } = Chakra.useColorMode();
  const label = colorMode === 'light' ? 'Dunkel' : 'Hell';
  const icon = colorMode === 'light'
    ? React.createElement(Icons.MoonIcon)
    : React.createElement(Icons.SunIcon);
  return html`
    <${Chakra.Button}
      size="sm"
      variant="outline"
      borderColor="lineColor"
      color="textPrimary"
      onClick=${toggleColorMode}
      aria-label="Theme wechseln"
      leftIcon=${icon}
    >${label}<//>
  `;
}

export function AppShell({ activeKey, title, subtitle, controls, children }) {
  const activeBg = Chakra.useColorModeValue('brand.500', 'brand.400');
  const activeText = Chakra.useColorModeValue('white', 'gray.900');
  const navHover = Chakra.useColorModeValue('navy.100', 'whiteAlpha.100');

  return html`
    <${Chakra.Flex} className="horizon-app-shell" minH="100vh" bg="appBg">
      <${Chakra.Box}
        as="aside"
        display=${{ base: 'none', lg: 'block' }}
        w="260px"
        borderRight="1px solid"
        borderColor="lineColor"
        bg="shellBg"
        px="5"
        py="6"
      >
        <${Chakra.Heading} size="md" color="textPrimary" mb="8">Music Scraper<//>
        <${Chakra.VStack} align="stretch" spacing="2">
          ${NAV_ITEMS.map((item) => html`
            <${Chakra.Link}
              key=${item.key}
              href=${item.href}
              target=${item.external ? '_blank' : undefined}
              rel=${item.external ? 'noreferrer' : undefined}
              px="3"
              py="2"
              borderRadius="12px"
              bg=${item.key === activeKey ? activeBg : 'transparent'}
              color=${item.key === activeKey ? activeText : 'textPrimary'}
              fontWeight="600"
              _hover=${{ textDecoration: 'none', bg: item.key === activeKey ? activeBg : navHover }}
            >
              ${item.label}
            <//>
          `)}
        <//>
      <//>

      <${Chakra.Box} flex="1" minW="0">
        <${Chakra.Flex}
          as="header"
          px=${{ base: '4', md: '6' }}
          py="4"
          align="center"
          justify="space-between"
          borderBottom="1px solid"
          borderColor="lineColor"
          bg="shellBg"
          position="sticky"
          top="0"
          zIndex="20"
        >
          <${Chakra.Box}>
            <${Chakra.Heading} size="md" color="textPrimary">${title}<//>
            ${subtitle ? html`<${Chakra.Text} mt="1" fontSize="sm" color="textMuted">${subtitle}<//>` : null}
          <//>
          <${Chakra.HStack} spacing="2">
            ${controls || null}
            <${ThemeToggleButton} />
          <//>
        <//>

        <${Chakra.Box} display=${{ base: 'block', lg: 'none' }} bg="shellBg" borderBottom="1px solid" borderColor="lineColor" px="4" py="3">
          <${Chakra.HStack} spacing="2" overflowX="auto" className="horizon-scroll">
            ${NAV_ITEMS.map((item) => html`
              <${Chakra.Button}
                key=${item.key}
                as="a"
                href=${item.href}
                target=${item.external ? '_blank' : undefined}
                rel=${item.external ? 'noreferrer' : undefined}
                size="sm"
                variant=${item.key === activeKey ? 'solid' : 'outline'}
                colorScheme=${item.key === activeKey ? 'blue' : 'gray'}
              >${item.label}<//>
            `)}
          <//>
        <//>

        <${Chakra.Box} px=${{ base: '4', md: '6' }} py="5">${children}<//>
      <//>
    <//>
  `;
}

export function PanelCard({ title, subtitle, right, children, p = '5' }) {
  const shadow = Chakra.useColorModeValue('0 10px 28px rgba(19, 47, 76, 0.08)', '0 10px 30px rgba(0, 0, 0, 0.35)');
  return html`
    <${Chakra.Box}
      bg="cardBg"
      borderRadius="20px"
      border="1px solid"
      borderColor="lineColor"
      boxShadow=${shadow}
      p=${p}
    >
      ${(title || subtitle || right) ? html`
        <${Chakra.HStack} align="start" justify="space-between" mb="4" spacing="3">
          <${Chakra.Box}>
            ${title ? html`<${Chakra.Heading} size="sm" color="textPrimary">${title}<//>` : null}
            ${subtitle ? html`<${Chakra.Text} mt="1" fontSize="sm" color="textMuted">${subtitle}<//>` : null}
          <//>
          ${right || null}
        <//>
      ` : null}
      ${children}
    <//>
  `;
}

export function useUiColors() {
  return {
    textPrimary: Chakra.useColorModeValue('navy.700', 'gray.100'),
    textMuted: Chakra.useColorModeValue('navy.500', 'gray.400'),
    lineColor: Chakra.useColorModeValue('navy.100', 'whiteAlpha.200'),
    subtleBg: Chakra.useColorModeValue('navy.50', 'whiteAlpha.100'),
    accentBg: Chakra.useColorModeValue('brand.500', 'brand.400'),
    cardBg: Chakra.useColorModeValue('white', 'gray.800')
  };
}

export async function apiFetch(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('de-DE');
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('de-DE');
}

export function useDebouncedValue(value, delayMs = 300) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export { React, createRoot, Chakra, Icons };
