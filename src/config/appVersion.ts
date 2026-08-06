// Single source of truth for the displayed application version (desktop
// sidebar, mobile עוד screen). __APP_VERSION__ is injected at build time by
// vite.config.ts's `define`, sourced from package.json's own `version` field
// -- so a release bump only ever touches one file, and every render site
// imports this same constant instead of hardcoding the string a second time.
import { APP_NAME } from '../domain/labels';

export const APP_VERSION = __APP_VERSION__;
export const APP_VERSION_LABEL = `${APP_NAME} v${APP_VERSION}`;
