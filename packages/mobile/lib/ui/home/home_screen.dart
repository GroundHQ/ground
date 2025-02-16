import 'package:flutter/widgets.dart';
import 'package:syncwave/models/board.dart';
import 'package:syncwave/ui/boards/board_screen.dart';
import 'package:syncwave/ui/boards/boards_list.dart';
import 'package:syncwave/ui/boards/new_board.dart';
import 'package:syncwave/ui/core/navigator/navigator.dart';
import 'package:syncwave/ui/core/themes/theme_extensions.dart';
import 'package:syncwave/ui/widgets/avatar.dart';
import 'package:syncwave/ui/widgets/bottom_bar.dart';
import 'package:syncwave/ui/widgets/icons.dart';
import 'package:syncwave/ui/widgets/navigation_stack.dart';

import '../widgets/bottom_sheet.dart';
import '../widgets/buttons.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return NavigationStack(
      title: 'Boards',
      leading: IconButton(
        child: Avatar(name: 'Andrei', size: context.icons.lg),
        onPressed: () {
          // Handle add board
          debugPrint('Profile page');
        },
      ),
      bottomBar: BottomBar(
        children: [
          IconButton(
            child: Icons.search,
            onPressed: () {
              // Handle add board
              debugPrint('Add board');
            },
          ),
          Text(
            '30 Boards',
            style: context.text.small,
          ),
          IconButton(
            child: Icons.plus,
            onPressed: () {
              // Handle add board
              showModalBottomSheet<void>(
                builder: (context) => NewBoard(),
                isDismissible: false,
                showDragHandle: false,
                context: context,
              );
            },
          ),
        ],
      ),
      // trailing: const [ThemeToggleButton()],
      child: BoardsList(
        boards: _generateSampleBoards(),
        onBoardTap: (board) {
          // Handle board tap
          context.pushPage(BoardScreen(board: board));
        },
      ),
    );
  }

  List<Board> _generateSampleBoards() {
    final usernames = [
      'Alice Johnson',
      'Bob Smith',
      'Charlie Brown',
      'Diana Prince',
      'Edward Norton',
      'Fiona Apple',
      'George Lucas',
      'Hannah Montana',
      'Ian McKellen',
      'Julia Roberts'
    ];

    final actions = [
      'added a new card',
      'commented on a task',
      'moved a card',
      'created a new list',
      'archived a card',
      'mentioned you',
      'assigned you a task',
      'shared a file',
      'updated the description of the board',
      'set a due date'
    ];

    final boardNames = [
      'Product Development',
      'Marketing Campaign',
      'Website Redesign',
      'Mobile App Launch',
      'Content Strategy',
      'Customer Feedback',
      'Team Projects',
      'Research & Analytics',
      'Design Systems',
      'Operations'
    ];

    final now = DateTime.now();

    return List.generate(30, (index) {
      final random = index % 10; // Use modulo to cycle through the sample data

      return Board(
        id: index,
        name: '${boardNames[random]} ${(index ~/ 10) + 1}',
        username: usernames[random],
        lastAction: LastAction(
          user: usernames[random],
          action: actions[random],
          date: now.subtract(Duration(
            minutes: index * 17, // Spread out the timestamps
          )),
        ),
      );
    });
  }
}
