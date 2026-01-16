# KingstonAccess - Accessible Parking Locator

A comprehensive web application designed to help users find accessible parking spaces in Kingston, Ontario. Built with accessibility, privacy, and user experience in mind.

## Features

### Core Functionality

- **AI-Powered Chat Interface**
  - Natural language destination queries (e.g., "I'm going to Metro")
  - Intelligent place name extraction from conversational input
  - Context-aware parking recommendations
  - Chat history with conversation reset capability

- **Interactive Map**
  - Google Maps integration with full zoom and pan controls
  - Real-time location tracking
  - Parking lot visualization with polygons and markers
  - Click-to-view parking lot information cards
  - Automatic map centering on destination selection

- **Smart Parking Search**
  - Free place search integration (Photon API)
  - Location suggestions with clickable buttons
  - Filter by accessible spaces only
  - Distance-based sorting (shows top 5 nearest)
  - Search across all parking lots in Kingston dataset

- **Navigation & Routing**
  - Turn-by-turn directions via Google Directions API
  - Route via accessible parking spots
  - Multiple travel modes (Driving, Transit, Walking)
  - Real-time traffic information
  - Route clearing functionality
  - Visual route display on map

- **Accessible Features Display**
  - Nearby accessibility features within 500m radius
  - Categorized by feature type
  - Total count display
  - Integration with Kingston accessible features dataset

### User Interface

- **Bilingual Support (EN/FR)**
  - Complete English and French translations
  - Language toggle in header
  - Persistent language preference
  - Dynamic HTML lang attribute

- **Collapsible Side Panels**
  - Left panel: Chat interface
  - Right panel: Results and parking lot lists
  - Toggle buttons for show/hide
  - Map expands to fill available space

- **Keyboard Shortcuts**
  - `Ctrl+K` / `Cmd+K`: Focus chat input
  - `Ctrl+L` / `Cmd+L`: Relocate user position
  - `Ctrl+[` / `Cmd+[`: Toggle left panel
  - `Ctrl+]` / `Cmd+]`: Toggle right panel
  - `?`: Show keyboard shortcuts help

- **Loading States**
  - Skeleton loaders for nearest options
  - Progress bars for AI chat
  - Loading spinners for map operations
  - Clear status messages

- **Responsive Design**
  - Mobile-friendly layout
  - Adaptive grid system
  - Touch-friendly controls

### Accessibility (AODA Compliant)

- **Keyboard Navigation**
  - Full keyboard accessibility
  - Skip links for screen readers
  - Focus management
  - Tab order optimization

- **Screen Reader Support**
  - ARIA labels and roles
  - Live regions for status updates
  - Semantic HTML structure
  - Descriptive button labels

- **Visual Accessibility**
  - High contrast color scheme
  - Focus indicators
  - Clear visual feedback
  - Readable font sizes

### Privacy & Compliance (MFIPPA Compliant)

- **Data Privacy**
  - Local data processing
  - No personal information storage
  - Minimal logging
  - Privacy notice displayed in UI

- **Security**
  - Environment variable configuration
  - Secure API key handling
  - No sensitive data in client code

## Technology Stack

### Frontend
- **React 18.3** - UI framework
- **TypeScript 5.6** - Type safety
- **Vite 5.4** - Build tool and dev server
- **@react-google-maps/api** - Google Maps integration
- **CSS3** - Styling with CSS variables

### Backend
- **Node.js** - Server runtime
- **Backboard AI** - LLM integration for natural language processing
- **Google Maps APIs**:
  - Maps JavaScript API
  - Directions API
  - Geocoding API

### Data Sources
- Kingston Open Data:
  - Parking Lot Areas (CSV + GeoJSON)
  - Accessible Features at Kingston Facilities (CSV)

## Installation

### Prerequisites

- Node.js 18+ and npm
- Google Maps API key
- Backboard AI API credentials (optional, for AI features)

### Setup Steps

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Accessible_Parking_locator
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   
   Create a `.env.local` file in the root directory:
   ```env
   # Frontend environment variables
   VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
   VITE_BACKBOARD_LLM_PROVIDER=google
   VITE_BACKBOARD_MODEL_NAME=gemini-2.5-flash
   
   # Backend environment variables
   VITE_BACKBOARD_API_KEY=your_backboard_api_key
   # Alternative: BACKBOARD_API_KEY=your_backboard_api_key
   PORT=8787
   ```
   
   Note: The `.env.local` file is already in `.gitignore` and will not be committed to the repository.

4. **Start the development server**
   ```bash
   # Terminal 1: Start frontend dev server
   npm run dev
   
   # Terminal 2: Start backend API server
   npm run api
   ```

5. **Open in browser**
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:8787

## Usage

### Basic Workflow

1. **Set Your Location**
   - Click "Relocate" button or use `Ctrl+L`
   - App automatically locates you on first load

2. **Search for a Destination**
   - Type in the chat box (e.g., "Metro", "Shoppers Drug Mart")
   - Select from suggested locations
   - Or use natural language: "I'm going to shoppers"

3. **View Results**
   - See top 5 nearest accessible parking lots
   - View nearby accessibility features
   - Click parking lots on map for details

4. **Navigate**
   - Click "Navigate" for direct route
   - Click "Navigate (via accessible parking)" for route through accessible spot
   - View turn-by-turn directions in right panel

### Advanced Features

- **Filter Parking Lots**
  - Toggle "Only show lots with accessible spaces"
  - Search by name in parking lots tab
  - View all parking lots in dataset

- **Customize View**
  - Collapse/expand side panels
  - Switch between Results and Parking Lots tabs
  - Use keyboard shortcuts for quick actions

- **Language Switching**
  - Click EN/FR buttons in header
  - All UI text updates immediately
  - Preference saved in localStorage

## Configuration

### Environment Variables

#### Frontend Environment Variables
- `VITE_GOOGLE_MAPS_API_KEY` - Required. Your Google Maps API key
- `VITE_BACKBOARD_LLM_PROVIDER` - Optional. Default: "google"
- `VITE_BACKBOARD_MODEL_NAME` - Optional. Default: "gemini-2.5-flash"

#### Backend Environment Variables
- `VITE_BACKBOARD_API_KEY` or `BACKBOARD_API_KEY` - Required for AI features
- `PORT` - Optional. Default: 8787

### API Endpoints

#### Backend Server (port 8787)
- `GET /api/health` - Health check endpoint
- `GET /api/nearest` - Get nearest parking lots
- `GET /api/predict` - Predict parking availability
- `POST /api/ai/thread` - Create or retrieve AI conversation thread
- `POST /api/ai/recommend-parking` - Get AI-powered parking recommendations
- `POST /api/ai/message` - Send message to AI assistant
- `POST /api/ai/reset-thread` - Reset AI conversation thread

## Development

### Available Scripts

- `npm run dev` - Start development server (port 5173)
- `npm run api` - Start backend API server (port 8787)
- `npm run build` - Build for production
- `npm run preview` - Preview production build

### Building for Production

```bash
npm run build
```

Output will be in the `dist/` directory.

### Code Style

- TypeScript strict mode enabled
- ESLint configuration (if configured)
- Consistent formatting

## Testing

### Manual Testing Checklist

- [ ] Location detection works
- [ ] Place search returns results
- [ ] AI chat understands natural language
- [ ] Navigation routes display correctly
- [ ] Language switching works
- [ ] Keyboard shortcuts function
- [ ] Panel collapse/expand works
- [ ] Accessibility features display
- [ ] Mobile responsiveness

## Data Sources

- **Kingston Open Data**
  - Parking Lot Areas dataset
  - Accessible Features at Kingston Facilities dataset

All data is processed locally in the browser. No data is sent to external servers except:
- Google Maps API (for map rendering and directions)
- Backboard AI API (for natural language processing, if enabled)

## Privacy & Security

- **MFIPPA Compliance**
  - No personal information collected
  - All processing done locally
  - Minimal server-side logging
  - Clear privacy notice in UI

- **Data Handling**
  - Location data stays in browser
  - No tracking or analytics
  - API keys stored in environment variables
  - Secure API communication

## Accessibility Features

- **AODA Compliance**
  - WCAG 2.1 Level AA standards
  - Keyboard navigation support
  - Screen reader compatibility
  - High contrast mode
  - Focus indicators

- **Keyboard Navigation**
  - All features accessible via keyboard
  - Logical tab order
  - Skip links for main content
  - Keyboard shortcuts documented

## Internationalization

- **Supported Languages**
  - English (EN)
  - French (FR)

- **Translation Coverage**
  - All UI text translated
  - Dynamic language switching
  - Persistent language preference
  - Proper locale formatting

## Progressive Web App (PWA)

- Installable on mobile devices
- Offline capability (limited)
- App manifest configured
- Service worker ready (if implemented)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

See LICENSE file for details.

## Acknowledgments

- Kingston Open Data for providing parking and accessibility datasets
- Google Maps Platform for mapping services
- Backboard AI for natural language processing
- React and Vite communities

## Support

For issues, questions, or contributions, please open an issue on the repository.

---

**Built for accessibility and inclusion**
