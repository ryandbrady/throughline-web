'use strict';

// A sample Figma document in the lightweight raw-node shape that
// build-a11y-tree.js consumes. It lets the web app run with zero setup —
// before the Figma Bridge plugin is connected and pushes a live document.
//
// Deliberately includes generic layer names ("Frame 12", "Group 5"), a
// decorative shape, and a hidden layer so the builder's heuristics are visible.

module.exports = {
  id: '0:0',
  name: 'Throughline Demo File',
  type: 'DOCUMENT',
  children: [
    {
      id: '1:0',
      name: 'Onboarding',
      type: 'CANVAS',
      visible: true,
      children: [
        {
          id: '1:2',
          name: 'Welcome Screen',
          type: 'FRAME',
          visible: true,
          children: [
            { id: '1:3', name: 'Logo', type: 'RECTANGLE', visible: true, hasImageFill: true },
            {
              id: '1:4',
              name: 'Heading',
              type: 'TEXT',
              visible: true,
              fontSize: 32,
              characters: 'Welcome to Throughline',
            },
            {
              id: '1:5',
              name: 'Subtitle',
              type: 'TEXT',
              visible: true,
              fontSize: 16,
              characters: 'Review and navigate any design as an accessible structure.',
            },
            {
              id: '1:6',
              name: 'Frame 12',
              type: 'FRAME',
              visible: true,
              children: [
                {
                  id: '1:7',
                  name: 'Get Started Button',
                  type: 'INSTANCE',
                  visible: true,
                  children: [
                    { id: '1:8', name: 'Label', type: 'TEXT', visible: true, characters: 'Get started' },
                  ],
                },
                {
                  id: '1:9',
                  name: 'Secondary Button',
                  type: 'INSTANCE',
                  visible: true,
                  children: [
                    { id: '1:10', name: 'Label', type: 'TEXT', visible: true, characters: 'Take a tour' },
                  ],
                },
              ],
            },
            { id: '1:11', name: 'Background Blur', type: 'ELLIPSE', visible: true },
          ],
        },
      ],
    },
    {
      id: '2:0',
      name: 'Dashboard',
      type: 'CANVAS',
      visible: true,
      children: [
        {
          id: '2:2',
          name: 'Dashboard Screen',
          type: 'FRAME',
          visible: true,
          children: [
            {
              id: '2:3',
              name: 'Page Title',
              type: 'TEXT',
              visible: true,
              fontSize: 28,
              characters: 'Your projects',
            },
            {
              id: '2:4',
              name: 'Group 5',
              type: 'GROUP',
              visible: true,
              children: [
                {
                  id: '2:5',
                  name: 'Project Card',
                  type: 'FRAME',
                  visible: true,
                  children: [
                    {
                      id: '2:6',
                      name: 'Card Title',
                      type: 'TEXT',
                      visible: true,
                      fontSize: 18,
                      characters: 'Marketing site',
                    },
                    {
                      id: '2:7',
                      name: 'Card Body',
                      type: 'TEXT',
                      visible: true,
                      characters: '12 frames · updated today',
                    },
                  ],
                },
                {
                  id: '2:8',
                  name: 'Project Card',
                  type: 'FRAME',
                  visible: true,
                  children: [
                    {
                      id: '2:9',
                      name: 'Card Title',
                      type: 'TEXT',
                      visible: true,
                      fontSize: 18,
                      characters: 'Mobile app',
                    },
                    {
                      id: '2:10',
                      name: 'Card Body',
                      type: 'TEXT',
                      visible: true,
                      characters: '34 frames · updated 2 days ago',
                    },
                  ],
                },
              ],
            },
            { id: '2:11', name: 'Hidden draft', type: 'FRAME', visible: false, children: [] },
          ],
        },
      ],
    },
  ],
};
